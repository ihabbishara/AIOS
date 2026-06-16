#!/usr/bin/env python3
"""One-time bunq setup: API key -> persisted API context (mode 0600). READ-ONLY usage only.

`ApiContext.create` performs bunq's full handshake from the official docs — generate an RSA
keypair, POST /installation (client_public_key) to obtain the installation token + server public
key, register the device-server, and start a session. `--verbose` prints each of those steps for
transparency/audit (presence, ids, and fingerprints only — never the secret tokens/keys).
"""
import argparse, hashlib, os, sys
from bunq.sdk.context.api_context import ApiContext, ApiEnvironmentType
from bunq.sdk.context.bunq_context import BunqContext


def _step(msg: str) -> None:
    print(f"  [bunq-setup] {msg}", file=sys.stderr)


def _fingerprint(obj) -> str:
    """A stable, non-secret sha256 fingerprint of the server public key (safe to print)."""
    try:
        from cryptography.hazmat.primitives import serialization
        pem = obj.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    except Exception:
        pem = str(obj).encode()
    return hashlib.sha256(pem).hexdigest()[:16]


def _verify(ctx) -> None:
    """Print each handshake step from bunq's installation doc (redacted)."""
    ic = ctx.installation_context
    sc = ctx.session_context
    _step("1/5 RSA client keypair: " + ("generated ✓" if ic.private_key_client is not None else "MISSING ✗"))
    _step("2/5 installation token: " + (f"obtained ✓ (len {len(ic.token)})" if ic.token else "MISSING ✗"))
    _step("3/5 server public key:  " + (f"retrieved ✓ (sha256 {_fingerprint(ic.public_key_server)})" if ic.public_key_server is not None else "MISSING ✗"))
    _step("4/5 device-server:      " + ("registered ✓ (session established below proves it)" if sc and sc.token else "NOT registered ✗"))
    if sc and sc.token:
        _step(f"5/5 session:            started ✓ (user_id {sc.user_id}, expires {sc.expiry_time})")
    else:
        _step("5/5 session:            NOT started ✗")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", choices=["sandbox", "production"], required=True)
    ap.add_argument("--context", required=True, help="path to write the context file")
    ap.add_argument("--api-key", required=True)
    ap.add_argument("--verbose", action="store_true", help="print each handshake step (redacted)")
    args = ap.parse_args()

    env = ApiEnvironmentType.SANDBOX if args.env == "sandbox" else ApiEnvironmentType.PRODUCTION
    _step(f"creating API context against {args.env} …")
    ctx = ApiContext.create(env, args.api_key, "AIOS read-only")
    if args.verbose:
        _verify(ctx)

    ctx.save(args.context)
    os.chmod(args.context, 0o600)
    BunqContext.load_api_context(ApiContext.restore(args.context))  # sanity-check the saved context
    print(f"bunq context saved: {args.context} ({args.env}, mode 0600)", file=sys.stderr)


if __name__ == "__main__":
    main()
