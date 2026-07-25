import json
import os
import time
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import firebase_admin
from firebase_admin import auth, credentials, db
import requests

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

BASE_DIR = Path(__file__).resolve().parent
SERVICE_ACCOUNT_JSON = os.getenv('FIREBASE_SERVICE_ACCOUNT_JSON')
SERVICE_ACCOUNT_PATH = os.getenv('GOOGLE_APPLICATION_CREDENTIALS')

FIREBASE_API_KEY = os.getenv('FIREBASE_API_KEY')
FIREBASE_DB_URL = os.getenv('FIREBASE_DB_URL', 'https://hesap-f6090-default-rtdb.europe-west1.firebasedatabase.app')

if not FIREBASE_API_KEY:
    raise RuntimeError('FIREBASE_API_KEY must be set in the environment')

if SERVICE_ACCOUNT_JSON:
    try:
        service_account_info = json.loads(SERVICE_ACCOUNT_JSON)
    except json.JSONDecodeError as exc:
        raise RuntimeError('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON') from exc
    cred = credentials.Certificate(service_account_info)
elif SERVICE_ACCOUNT_PATH:
    service_account_path = Path(SERVICE_ACCOUNT_PATH)
    if not service_account_path.exists():
        raise RuntimeError(f'Firebase service account file not found: {service_account_path}')
    cred = credentials.Certificate(str(service_account_path))
else:
    default_service_account = BASE_DIR / 'hesap-f6090-firebase-adminsdk-fbsvc-f9d792b5d4.json'
    if not default_service_account.exists():
        raise RuntimeError(
            'Firebase service account not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON or ' \
            'GOOGLE_APPLICATION_CREDENTIALS to a valid JSON file path.'
        )
    cred = credentials.Certificate(str(default_service_account))

firebase_admin.initialize_app(cred, {'databaseURL': FIREBASE_DB_URL})

app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path='')
CORS(app, resources={r"/api/*": {"origins": "*"}})

IDENTITY_URL = f'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={FIREBASE_API_KEY}'
REFRESH_URL = f'https://securetoken.googleapis.com/v1/token?key={FIREBASE_API_KEY}'


def now_str():
    t = time.localtime()
    return f'{t.tm_mday:02}.{t.tm_mon:02}.{t.tm_year} {t.tm_hour:02}:{t.tm_min:02}'


def client_ip():
    forwarded = request.headers.get('X-Forwarded-For')
    if forwarded:
        return forwarded.split(',')[0].strip()
    return request.remote_addr or 'bilinmiyor'


def log_event(user, action, detail, ip=None):
    if ip is None:
        ip = client_ip()
    payload = {
        'user': user or 'Bilinmiyor',
        'action': action,
        'detail': detail,
        'ip': ip,
        'ts': int(time.time() * 1000),
        'tarih': now_str(),
    }
    try:
        db.reference('/loglar').push(payload)
    except Exception as exc:
        app.logger.error('Failed to write log event: %s', exc)


def auth_required(fn):
    def wrapper(*args, **kwargs):
        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return jsonify({'error': 'Yetkilendirme gerekli'}), 401
        token = auth_header.split(' ', 1)[1]
        try:
            decoded = auth.verify_id_token(token)
            request.user = decoded
        except Exception as exc:
            app.logger.warning('Token doğrulama hatası: %s', exc)
            return jsonify({'error': 'Geçersiz veya süresi dolmuş token'}), 401
        return fn(*args, **kwargs)
    wrapper.__name__ = fn.__name__
    return wrapper


@app.route('/')
def index():
    return send_from_directory(str(BASE_DIR), 'index.html')


@app.route('/<path:filename>')
def static_files(filename):
    return send_from_directory(str(BASE_DIR), filename)


@app.route('/api/login', methods=['POST'])
def api_login():
    payload = request.get_json(silent=True) or {}
    email = (payload.get('email') or '').strip()
    password = payload.get('password', '')
    if not email or not password:
        return jsonify({'error': 'E-posta ve şifre giriniz.'}), 400

    response = requests.post(IDENTITY_URL, json={
        'email': email,
        'password': password,
        'returnSecureToken': True,
    }, timeout=10)
    result = response.json()
    ip = client_ip()
    if response.status_code != 200 or 'error' in result:
        message = None
        if isinstance(result.get('error'), dict):
            message = result['error'].get('message')
        if not message:
            message = result.get('error') or 'Giriş başarısız'
        log_event(email, 'Başarısız giriş denemesi', f'Kod: {message} | IP: {ip}', ip)
        return jsonify({'error': message, 'ip': ip}), 401

    log_event(email, 'Giriş başarılı', 'Kullanıcı giriş yaptı', ip)
    return jsonify({
        'idToken': result.get('idToken'),
        'refreshToken': result.get('refreshToken'),
        'expiresIn': result.get('expiresIn'),
        'email': email,
        'ip': ip,
    })


@app.route('/api/refresh', methods=['POST'])
def api_refresh():
    payload = request.get_json(silent=True) or {}
    refresh_token = payload.get('refreshToken', '')
    if not refresh_token:
        return jsonify({'error': 'refreshToken gerekli'}), 400

    response = requests.post(REFRESH_URL, data={
        'grant_type': 'refresh_token',
        'refresh_token': refresh_token,
    }, timeout=10)
    result = response.json()
    if response.status_code != 200 or 'error' in result:
        message = result.get('error', {}).get('message') if isinstance(result.get('error'), dict) else result.get('error')
        return jsonify({'error': message or 'Token yenilenemedi'}), 401

    return jsonify({
        'idToken': result.get('id_token'),
        'refreshToken': result.get('refresh_token'),
        'expiresIn': result.get('expires_in'),
    })


@app.route('/api/hesaplar', methods=['GET'])
@auth_required
def api_hesaplar_get():
    data = db.reference('/hesaplar').get() or []
    return jsonify(data)


@app.route('/api/hesaplar', methods=['PUT'])
@auth_required
def api_hesaplar_put():
    payload = request.get_json(silent=True)
    if payload is None:
        return jsonify({'error': 'Geçersiz JSON'}), 400
    db.reference('/hesaplar').set(payload)
    return jsonify({'ok': True})


@app.route('/api/log', methods=['GET'])
@auth_required
def api_log_get():
    data = db.reference('/loglar').get() or {}
    return jsonify(data)


@app.route('/api/log', methods=['POST'])
@auth_required
def api_log_post():
    payload = request.get_json(silent=True) or {}
    action = payload.get('action', 'Unknown')
    detail = payload.get('detail', '')
    user = request.user.get('email') or request.user.get('uid')
    log_event(user, action, detail)
    return jsonify({'ok': True})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', '8000')), debug=False)
