# Pennywise

## Run locally

Install Node.js 18 or later, then run this from the project folder:

```powershell
npm.cmd start
```

Open `http://127.0.0.1:3000/` to start at the login page. The Command Center is also available directly at `http://127.0.0.1:3000/command_center.html`. Keep the terminal window open while using the app. Press `Ctrl+C` in that window to stop the backend.

The backend uses only Node.js built-in modules; no package installation is required. It creates `backend/data.json` on first start and saves expenses, bills, trial reminders, and the current balance there.

## API

- `GET /api/health` — backend status
- `GET /api/data` — tracker data
- `PUT /api/balance` — update the available balance
- `POST /api/transactions` — add an expense
- `POST /api/bills` — add an upcoming payment
- `PATCH /api/bills/:id/paid` — mark a payment paid
- `POST /api/trials` — add a trial reminder
- `DELETE /api/trials/:id` — remove a trial reminder
- `DELETE /api/subscriptions/:id` — hide a subscription from the radar

This is a local development backend, bound to `127.0.0.1`. It has no user accounts or authentication and should not be exposed to the public internet or used to store real financial credentials.
