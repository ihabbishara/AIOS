#!/usr/bin/env python3
"""Read-only bunq fetcher: list monetary accounts + their payments, print the fixed JSON contract.
NO payment / draft-payment / write endpoint is called or imported here — read-only by construction."""
import argparse, json, sys

PAGE = 200

def to_cents(value: str) -> int:
    # bunq amount.value is a decimal string like "-12.99"
    neg = value.strip().startswith("-")
    digits = value.replace("-", "").split(".")
    euros = int(digits[0])
    cents = int((digits[1] + "00")[:2]) if len(digits) > 1 else 0
    total = euros * 100 + cents
    return -total if neg else total

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", required=True)
    ap.add_argument("--context", required=True)
    ap.add_argument("--backfill-days", type=int, default=90)
    ap.add_argument("--since", default="{}", help='JSON map account_id -> last bunq_id')
    args = ap.parse_args()
    since = json.loads(args.since)

    from bunq.sdk.context.api_context import ApiContext
    from bunq.sdk.context.bunq_context import BunqContext
    from bunq.sdk.model.generated.endpoint import MonetaryAccountBank, Payment

    try:
        BunqContext.load_api_context(ApiContext.restore(args.context))
    except Exception as e:
        print(f"BUNQ_REAUTH_REQUIRED: run scripts/bunq-setup.py ({e})", file=sys.stderr)
        sys.exit(2)

    accounts, transactions = [], []
    for acc in MonetaryAccountBank.list().value:
        if acc.status != "ACTIVE":
            continue
        acc_id = str(acc.id_)
        label = acc.description or f"account-{acc_id}"
        accounts.append({"id": acc_id, "label": label, "currency": acc.currency})
        params = {"count": str(PAGE)}
        newer = since.get(acc_id)
        if newer:
            params["newer_id"] = str(newer)
        # NOTE: verify Payment.list signature against the installed bunq_sdk version (sandbox step).
        for p in Payment.list(monetary_account_id=int(acc_id), params=params).value:
            cp = None; cp_iban = None
            try:
                lm = p.counterparty_alias.label_monetary_account
                cp = lm.display_name; cp_iban = lm.iban
            except Exception:
                pass
            transactions.append({
                "bunq_id": int(p.id_),
                "account_id": acc_id,
                "account_label": label,
                "amount_cents": to_cents(p.amount.value),
                "currency": p.amount.currency,
                "description": p.description or "",
                "counterparty": cp,
                "counterparty_iban": cp_iban,
                "type": getattr(p, "sub_type", None) or getattr(p, "type_", None),
                "bunq_created": p.created,
            })
    json.dump({"accounts": accounts, "transactions": transactions}, sys.stdout)

if __name__ == "__main__":
    main()
