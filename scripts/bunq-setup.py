#!/usr/bin/env python3
"""One-time bunq setup: API key -> persisted API context (mode 0600). READ-ONLY usage only."""
import argparse, os, sys
from bunq.sdk.context.api_context import ApiContext, ApiEnvironmentType
from bunq.sdk.context.bunq_context import BunqContext

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", choices=["sandbox", "production"], required=True)
    ap.add_argument("--context", required=True, help="path to write the context file")
    ap.add_argument("--api-key", required=True)
    args = ap.parse_args()
    env = ApiEnvironmentType.SANDBOX if args.env == "sandbox" else ApiEnvironmentType.PRODUCTION
    ctx = ApiContext.create(env, args.api_key, "AIOS read-only")
    ctx.save(args.context)
    os.chmod(args.context, 0o600)
    BunqContext.load_api_context(ApiContext.restore(args.context))  # sanity-check the saved context
    print(f"bunq context saved: {args.context} ({args.env})", file=sys.stderr)

if __name__ == "__main__":
    main()
