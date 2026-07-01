# ZMH Backend

Express + MongoDB backend for the ZMH frontend.

## Setup

1. Copy `.env.example` to `.env`.
2. Add your MongoDB URI, JWT secret, and Resend API key.
3. Run `npm install`.
4. Run `npm run dev`.

## Render

- Build command: `npm install`
- Start command: `npm start`
- Add all required environment variables from `.env.example`.

## Main API routes

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/otp/send`
- `POST /api/auth/otp/resend`
- `POST /api/auth/otp/verify`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `POST /api/bookings`
- `GET /api/bookings`
- `POST /api/contact`
- `GET /api/dashboard/profile`
- `GET /api/invoices`
- `GET /api/notifications`
- `POST /api/chatbot/query`
- `GET /api/admin/users`
- `PATCH /api/admin/users/:id`
- `GET /api/admin/bookings`
- `PATCH /api/admin/bookings/:id`
- `GET /api/admin/bills`
- `PATCH /api/admin/bills/:id`
- `POST /api/admin/settings`
