# AaGeJa Usage Meter

Counts completed agent runs per customer and seat, for usage reporting and
overage billing. MindStudio's own usage report shows every portal user as
"anonymous"; this is where runs are attributed to a customer.

## How it works

1. A customer opens an agent from their seat link. The Agent Access Service
   adds `ac` to the launch URL — a signed token naming the customer and seat.
2. The agent's last block posts `{ ac, run_id, agent }` to `/meter`.
3. This service checks the signature and writes one line: time, customer,
   seat, agent, run id. Nothing else — no names, no email, no content.

A run that fails part-way never reaches the last block, so only completed
runs are counted. `/meter` always answers 200, so metering can never fail a
customer's run.

**Why a separate service.** Records need a Railway volume, and a service with
a volume goes briefly offline on every redeploy. Kept apart, the customer
portal never does. This service redeploys only when this repo changes.

## Variables (Railway → usage-meter → Variables)

| Variable | |
|---|---|
| `SERVICE_KEY` | **Same value as the agent-access service, character for character.** It verifies the token |
| `ADMIN_KEY` | Opens the usage pages |

Railway does not redeploy on a variable change. Change one, then deploy.

## Volume

Mount path `/data`. Without a volume nothing is recorded, and the service
says so on `/healthz`, in its log and on every usage page.

## Check it is working

`/healthz` should read:

```json
{ "ok": true, "version": "1.1.0", "meter_recording": true,
  "service_key": "matches", "admin_key_present": true }
```

`service_key: "does_not_match"` means the two `SERVICE_KEY` values differ —
every run will be refused until they match.

## Reading usage

| Page | |
|---|---|
| `/usage?k=ADMIN_KEY` | Every customer: this month, contract year, all time |
| `/usage/<client_id>?k=ADMIN_KEY` | One customer, by month, agent and seat, then every run: time, agent, seat, run id |
| `/usage/<client_id>/csv?k=ADMIN_KEY` | Every row, as a file |

Times are UTC. A run's time is when it finished; its run id is the one MindStudio shows for the same run. Seats are shown by seat id only.

## Customer settings — `clients.json`

```json
{ "acme": { "name": "Acme Corporation", "year_start": "2026-01-15", "runs_allowance": 4000 } }
```

Optional. Gives the page a display name and an allowance line. A customer not
listed still has a page once it has runs, under its customer id.

**Customer names and contract terms go in this file only while the repo is
private.**

## What `/meter` answers

`{ "recorded": true }`, or `{ "recorded": false, "reason": ... }`:

| Reason | Means |
|---|---|
| `no_token` | No `ac` — a run from MindStudio's preview, or `ac` not declared on the agent |
| `no_run_id` | The block did not send `{{global.threadId}}` |
| `invalid_token` | Signature does not verify — edited, or the `SERVICE_KEY`s differ |
| `token_too_old` | Token expired more than seven days ago |
| `duplicate` | That run id is already recorded |
| `no_storage` | No volume attached |
| `write_failed` | The volume refused the write — see the log |
| `bad_request` | Body was not a JSON object |
