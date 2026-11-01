# Supabase PostgreSQL trust root

`supabase-ca.crt` is the **public** Supabase Root 2021 CA certificate, not a private key or credential.

- Source: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
- SHA-256 fingerprint: `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`
- Expires: April 26, 2031.

The production `DATABASE_URL` uses `sslmode=verify-full&sslrootcert=certs/supabase-ca.crt`. Run the app from the repository root (`npm start`) so this relative path resolves. This verifies both the certificate chain and hostname; do not work around certificate errors by disabling verification. Replace the certificate from the Supabase Dashboard when the provider rotates its trust root.
