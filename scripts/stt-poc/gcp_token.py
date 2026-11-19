#!/usr/bin/env python3
"""
서비스 계정 JSON 키로 Google OAuth 액세스 토큰을 발급해 stdout 에 쓴다.

    python3 scripts/stt-poc/gcp_token.py /path/to/key.json

키 경로는 인자로만 받는다(저장소에 키를 두지 않는다). 서명은 openssl 로 한다.
"""
import base64
import json
import subprocess
import sys
import tempfile
import time

SCOPE = "https://www.googleapis.com/auth/cloud-platform"


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def main() -> None:
    key = json.load(open(sys.argv[1]))
    now = int(time.time())
    header = b64(json.dumps({"alg": "RS256", "typ": "JWT", "kid": key["private_key_id"]}).encode())
    claims = b64(json.dumps({
        "iss": key["client_email"], "scope": SCOPE, "aud": key["token_uri"],
        "iat": now, "exp": now + 3600,
    }).encode())
    signing_input = f"{header}.{claims}".encode()
    with tempfile.NamedTemporaryFile("w", suffix=".pem") as pem:
        pem.write(key["private_key"])
        pem.flush()
        sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", pem.name],
                             input=signing_input, capture_output=True, check=True).stdout
    assertion = f"{header}.{claims}.{b64(sig)}"
    r = subprocess.run(
        ["curl", "-sS", "--max-time", "30", key["token_uri"],
         "--form-string", "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer",
         "--form-string", f"assertion={assertion}"],
        capture_output=True, text=True,
    )
    try:
        tok = json.loads(r.stdout)["access_token"]
    except (KeyError, json.JSONDecodeError):
        sys.exit(f"token exchange failed: {r.stdout[:300]} {r.stderr[:300]}")
    print(tok)


if __name__ == "__main__":
    main()
