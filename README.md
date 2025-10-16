# Gomel Cars Backend

Express + SQLite backend that matches your existing frontend contexts (`CarContext.jsx`, `AuthContext.jsx`, `AdminContext.jsx`, `Booking.jsx`, `Contact.jsx`).

## Quick Start

- Copy env

```bash
cp .env.example .env
```

- Install deps

```bash
npm i
```

- Initialize database (tables + seed admin + seed cars from frontend `project/src/data/cars.json` if found)

```bash
npm run migrate
```

- Run dev server

```bash
npm run dev
```

Server runs at `http://localhost:4000`.

## Auth Model

- JWT in `Authorization: Bearer <token>`.
- User token payload: `{ id, role: 'user' }`
- Admin token payload: `{ id, role: 'admin' }`

Default admin (seeded by migration):
- Email: `admin@gomelcars.com`
- Password: `admin123`

## API Endpoints

Base URL: `/api`

- Auth
  - POST `/auth/signup` { email, password, fullName?, mobile? } -> { user, token }
  - POST `/auth/login` { email, password } -> { user, token }
  - GET `/auth/me` (user JWT)
  - POST `/auth/request-otp` { email, purpose: 'login'|'signup' } -> { message, expiresAt, devCode? }
  - POST `/auth/verify-otp` { email, code, fullName?, mobile? } -> { user, token }

- Admin
  - POST `/admin/login` { email, password } -> { admin, token }
  - GET `/admin/me` (admin JWT)

- Cars
  - GET `/cars` -> [car]
  - GET `/cars/:id` -> car
  - POST `/cars` (admin) body matches fields used in `CarModal.jsx`: { name, type, fuel, transmission, pricePerDay, rating?, seats?, image?, city?, brand?, description?, available? }
  - PUT `/cars/:id` (admin) any subset of above fields
  - DELETE `/cars/:id` (admin)

- Bookings
  - GET `/bookings/me` (user) -> bookings for current user
  - GET `/bookings` (admin) -> all bookings
  - GET `/bookings/:id` (admin) -> one booking
  - POST `/bookings` (user) -> create booking after payment success
    - Body matches data prepared in `Payment.jsx` + document previews from `Booking.jsx`:
      ```json
      {
        "carId": 1,
        "pickupDate": "2025-10-12",
        "returnDate": "2025-10-14",
        "pickupLocation": "Mumbai",
        "returnLocation": "Mumbai",
        "verification": {
          "idType": "Aadhaar",
          "idNumber": "123456789012",
          "licenseNumber": "GJ0520211234567",
          "licenseExpiry": "2026-01-01",
          "attachments": { "idFront": true, "idBack": true, "license": true },
          "attachmentsData": { "idFront": "data:image/png;base64,...", "idBack": "...", "license": "..." }
        },
        "totalCost": 4400,
        "days": 2,
        "payment": { "id": "PAY123456", "method": "upi", "status": "success" }
      }
      ```
    - Any `attachmentsData` provided will be saved under `/uploads/bookings/<bookingId>/<kind>.png` and exposed at `GET /uploads/...`.
  - DELETE `/bookings/:id` (admin)

- Messages
  - POST `/messages` { name, email, message } (public)
  - GET `/messages` (admin)
  - DELETE `/messages/:id` (admin)

## Static Files

- `/uploads` is served statically. Booking attachments saved as PNG from the base64 data URLs produced client-side.

## Frontend Integration Guide (minimal changes)

Your frontend currently uses localStorage contexts. You can progressively switch to the API:

- `AuthContext.jsx`
  - Replace local create/login with calls to `/api/auth/signup` and `/api/auth/login`.
  - Store `{ token, user }` in localStorage; attach `Authorization` header to user endpoints.

- `AdminContext.jsx`
  - Replace static credentials with `/api/admin/login` and store the admin token.
  - For admin-only pages like `AdminDashboard.jsx` use the admin token when calling cars/bookings/messages endpoints.

- `CarContext.jsx`
  - Replace `cars.json` bootstrapping with `GET /api/cars`.
  - Replace `addCar/updateCar/removeCar` with POST/PUT/DELETE `/api/cars` (admin token required).
  - Replace `addBooking/removeBooking/getUserBookings/getAllBookings` with corresponding `/api/bookings` endpoints.
  - Replace `submitContactForm/getAllMessages/deleteMessage` with `/api/messages` endpoints (admin token for read/delete).

- `Booking.jsx` and `Payment.jsx`
  - Keep client-side verification.
  - After successful payment simulation in `Payment.jsx`, instead of `addBooking()` in context, call `POST /api/bookings` with the same payload you already construct (including `verification.attachmentsData`).

## Notes

- CORS is open by default for local dev. Tighten `cors()` as needed.
- SQLite DB stored under `backend/data/gomel.db`.
- Use a strong `JWT_SECRET` in production.
- OTP in dev returns `devCode` in the response for easy testing. In production, integrate email/SMS delivery and do not expose the code.
