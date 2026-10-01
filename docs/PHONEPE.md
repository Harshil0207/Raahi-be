# PhonePe payments

Raahi collects fares through PhonePe's **v2 Standard Checkout** API. This
document is the operational half: what to configure, how the money actually
moves, and what to change when going live.

Every endpoint and field below is from PhonePe's own API reference, linked at
the bottom. Nothing here is invented, and where their documentation contradicts
itself that is called out rather than resolved silently.

---

## 1. Sandbox setup

PhonePe **does not publish shared sandbox credentials**. Each merchant is issued
their own from the PhonePe Business dashboard, so there is nothing to copy from
this document — you have to register and be given:

| Value | Where it goes |
|---|---|
| Client ID | `PHONEPE_CLIENT_ID` |
| Client Secret | `PHONEPE_CLIENT_SECRET` |
| Client Version | `PHONEPE_CLIENT_VERSION` |
| Merchant ID | `PHONEPE_MERCHANT_ID` (only needed for partner integrations) |

Then, in the dashboard's webhook section, configure the callback URL with
authentication type **SHA** and a username and password of your choosing. Those
two go into `PHONEPE_WEBHOOK_USERNAME` and `PHONEPE_WEBHOOK_PASSWORD`. PhonePe
hashes them as `SHA256(username:password)` and sends the digest as the
callback's `Authorization` header; without them configured on our side,
callbacks are **refused**, not trusted.

## 2. Environment variables

All of them live in `.env`, which is gitignored. `.env.example` lists them with
empty values. None of these is ever written to MongoDB or returned by any API,
including the admin API — see §8.

```
PHONEPE_ENV=sandbox            # sandbox (default) | production
PHONEPE_MERCHANT_ID=
PHONEPE_CLIENT_ID=
PHONEPE_CLIENT_SECRET=
PHONEPE_CLIENT_VERSION=
PHONEPE_REDIRECT_URL=          # where the customer comes back to
PHONEPE_WEBHOOK_USERNAME=
PHONEPE_WEBHOOK_PASSWORD=

# Optional
PHONEPE_BASE_URL=              # override the API host
PHONEPE_AUTH_BASE_URL=         # override the token host
PHONEPE_EXPIRE_AFTER_SECONDS=900   # 300–3600
PHONEPE_TIMEOUT_MS=15000
```

`PHONEPE_ENV` must say `production` in so many letters before anything talks to
the live host. A missing or misspelt value is sandbox, because the cost of
guessing wrong in that direction is a confused developer and in the other
direction it is somebody's actual money.

Setting the variables is not enough on its own. The active gateway is a platform
setting: in the admin console set **`finance.paymentProvider`** to `phonepe`,
and **`payment.upiEnabled`** to on. Until both are set, online payment is
offered to nobody.

### A documentation discrepancy worth knowing about

PhonePe's UAT Sandbox page gives the sandbox host as
`https://api-preprod.phonepe.com/apis/pgsandbox`, while the API reference pages
for authorization, create payment, order status and refund all give
`https://api-preprod.phonepe.com/apis/pg-sandbox` — with a hyphen. The four
consistent pages are what the code defaults to. If your account turns out to be
served by the other spelling, `PHONEPE_BASE_URL` and `PHONEPE_AUTH_BASE_URL`
exist so it is a line in an env file rather than a code change.

## 3. Endpoints used

| Purpose | Method | Path (sandbox) |
|---|---|---|
| Access token | POST | `{auth}/v1/oauth/token` |
| Create payment | POST | `{api}/checkout/v2/pay` |
| Order status | GET | `{api}/checkout/v2/order/{merchantOrderId}/status` |
| Refund | POST | `{api}/payments/v2/refund` |
| Refund status | GET | `{api}/payments/v2/refund/{merchantRefundId}/status` |

Where `{auth}` and `{api}` are both
`https://api-preprod.phonepe.com/apis/pg-sandbox` in sandbox, and in production
are `https://api.phonepe.com/apis/identity-manager` and
`https://api.phonepe.com/apis/pg` respectively — **two different hosts**, which
is the detail most likely to be missed when switching.

Authentication on every call but the token itself is
`Authorization: O-Bearer <access_token>`. Note `O-Bearer`, not `Bearer`.

Amounts cross **in paise as integers**, minimum 100. The provider converts; the
rest of the codebase works in rupees and never sees a paise value.

## 4. Our API

| Route | Who | Does |
|---|---|---|
| `POST /api/v1/payments/:rideId/checkout` | customer | Opens a checkout, returns the URL |
| `GET /api/v1/payments/:paymentId/status` | either party | Authoritative status, re-asking the gateway |
| `GET /api/v1/payments/:rideId/status` | either party | The same, addressed by ride |
| `POST /api/v1/payments/webhook` | PhonePe | Callback; signature-authenticated, public |
| `POST /api/v1/admin/payments/:paymentId/refund` | admin | Requests a refund (`FINANCE_ADJUST`) |
| `POST /api/v1/admin/payments/:paymentId/refund/reconcile` | admin | Re-asks the gateway; posts the reversal if confirmed (`FINANCE_ADJUST`) |
| `GET /api/v1/admin/payments-overview` | admin | Provider, environment, counts (`FINANCE_READ`) |

## 5. Callback configuration

Point the dashboard's webhook at:

```
https://<your-host>/api/v1/payments/webhook
```

It is deliberately public — a gateway has no session — and proves itself with
the `Authorization` digest instead. **The path is also referenced as
`WEBHOOK_PATH` in `src/app.js`**, where the raw request body is captured for
signature verification. Changing one without the other silently breaks every
callback.

Events PhonePe sends: `checkout.order.completed`, `checkout.order.failed`,
`pg.refund.completed`, `pg.refund.failed`.

One callback URL covers both things Raahi collects. A fare and a rider's
balance recharge go through the same gateway and their callbacks are
indistinguishable, so the handler looks for a fare first and asks the recharge
service second before writing a reference off as unknown. Either way the body
is only read for the reference; what happened is asked of the order status API.

## 6. Local development

The callback has to reach your machine, so `localhost` will not do. Use a
tunnel:

```bash
# any tunnel works; the URL goes in both places below
PHONEPE_REDIRECT_URL=https://<tunnel>/payments/return
# and the dashboard webhook URL: https://<tunnel>/api/v1/payments/webhook
```

Without a tunnel the payment still works — the status poll is a settlement path
in its own right and will confirm the payment within a few seconds — but you
will not exercise the callback.

## 7. Payment lifecycle

```
trip ends
  → ride AWAITING_PAYMENT, fare fixed server-side
  → customer taps Pay (or the rider shows the QR of the same checkout)
  → an ATTEMPT is created with a fresh merchantOrderId
  → POST /checkout/v2/pay  →  redirectUrl
  → customer pays at PhonePe
  → whichever arrives first:
        callback  →  signature checked  →  gateway re-asked
        poll      →  gateway asked
  → PAID, and only then:
        ledger posted (rider earning, platform commission, collection)
        ride COMPLETED
```

Two things are worth being explicit about.

**The callback is a prompt, not an answer.** Its body is never believed. It is
read for one thing — which order it is about — and then the order status API is
called. A forged callback therefore achieves nothing.

**Settlement is idempotent in three layers.** A duplicate callback returns early
once the ride is COMPLETED; the wallet ledger's entries are keyed on the ride
with a unique index, so a second posting is refused by the database rather than
by a check; and the ride's move to COMPLETED is a conditional update, so only
one caller runs the side effects.

## 8. Failure handling

| What happened | What the customer sees | What the ride does |
|---|---|---|
| Gateway unreachable | "The payment could not be started" | stays AWAITING_PAYMENT |
| Payment failed at PhonePe | "Payment failed" + Try again | stays AWAITING_PAYMENT |
| Still pending | "Being confirmed. Do not pay again." | stays AWAITING_PAYMENT |
| Paid less than the fare | recorded as failed, amounts named | stays AWAITING_PAYMENT |
| Paid | "Payment successful" | COMPLETED |

A retry always creates a **new attempt with a new merchant order id**. Gateways
refuse a reused one, so this is load-bearing rather than tidy. The ride is never
recreated.

**Nothing secret is logged.** The token request is the one call whose body is
never echoed into an error, because the body is the client secret. Gateway error
codes go to the log; the customer gets a sentence.

## 9. Refunds

`POST /api/v1/admin/payments/:paymentId/refund` asks PhonePe to refund and
records the request. **It does not move the ledger.** PhonePe settles refunds
asynchronously, so the money has not gone anywhere when that call returns, and
writing a reversal then would mean the books say a customer was refunded because
somebody asked.

The ledger moves in exactly one place: `refreshRefund`, once PhonePe's refund
status API answers `COMPLETED`. Three things reach it, and none of them is
trusted on its own —

| Trigger | What it does |
|---|---|
| The refund request itself | asks once, in case the gateway settled instantly |
| `pg.refund.completed` callback | signature checked, then the status API is asked anyway |
| `POST /admin/payments/:paymentId/refund/reconcile` | the manual version, for when no callback arrived |

The reversal is posted through the same `walletService.refundRide` the admin
console's own refund uses, with the same ride-derived idempotency keys — so a
refund confirmed twice, or one confirmed after a manual reversal, posts nothing
the second time because the database refuses the duplicate key.

**Partial refunds are refused, not half-done.** The ledger reverses a ride line
for line and the keys come from the ride, so there is no honest way to post
four-fifths of that; doing it properly means deciding whose share shrinks — the
rider's, the platform's, or both in proportion — and that is a commercial policy
rather than an arithmetic detail. `POST .../refund` with an amount below the fare
answers `400` saying so.

A provider that has no refund support answers `501` naming itself, rather than
pretending.

## 10. Going to production

1. Obtain production credentials from PhonePe (separate from UAT).
2. Set `PHONEPE_ENV=production` — this switches **both** hosts, and they differ.
3. Update `PHONEPE_REDIRECT_URL` to the production domain.
4. Configure the production webhook URL and a **new** username/password.
5. Set `finance.paymentProvider=phonepe` and `payment.upiEnabled=true` in the
   production admin console — settings live in the database and do not travel
   with a deploy.
6. Check `GET /api/v1/admin/payments-overview` reports `mode: production` and an
   empty `missing` list.
7. Take one real low-value payment and refund it.

The app refuses to take payments if it is running with `NODE_ENV=production`
while PhonePe is still in sandbox — that combination takes payments that will
never settle, so it fails loudly rather than quietly.

---

## Sources

- [Authorization](https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/authorization)
- [Create Payment](https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/create-payment)
- [Order Status](https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/order-status)
- [Webhook Handling](https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/webhook)
- [UAT Sandbox](https://developer.phonepe.com/payment-gateway/uat-testing-go-live/uat-sandbox)
- [Website Checkout introduction](https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-integration-website)
