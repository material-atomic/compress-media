# Security policy

## Deployment model

Compress Media **requires a login by default**:

- signed, HttpOnly session cookies for the browser;
- HTTP Basic or a bearer token (`AUTH_TOKEN`) for scripts;
- a rate limit on failed logins (10 per address per 15 minutes).

It is a **single-account** tool. Everyone who signs in shares the same jobs, so give it to one person or one trusted team.

The server binds to `127.0.0.1` by default, and the Compose files publish the port on `127.0.0.1` only. When you expose it:

- put **HTTPS** in front with a reverse proxy;
- set `TRUST_PROXY` so the rate limit sees real client addresses;
- consider `MAX_UPLOAD_MB`.

With `AUTH_ENABLED=false`, anyone who can reach the port can upload files, use your CPU, and download results while they're kept (3 hours by default).

Other built-in protections:

- Webhook URLs that resolve to private, loopback or link-local addresses are refused unless `WEBHOOK_ALLOW_PRIVATE=true` (SSRF protection). Deliveries can be signed with `WEBHOOK_SECRET`.
- Ghostscript runs with `-dSAFER`, and every tool runs as a separate process without a shell.
- Uploaded file names are never used as paths.
- The server only deletes its own `uploads/` and `outputs/` folders.

With `STORAGE=s3`, the app's credentials need:

- `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload` and `s3:ListMultipartUploadParts` on the bucket;
- `s3:ListBucket`;
- `s3:GetBucketCORS` and `s3:PutBucketCORS` only if you use `S3_SETUP_CORS`.

Scope them to that one bucket or prefix. Browsers only ever receive short-lived presigned URLs, never the credentials.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private reporting instead: go to the **Security** tab and choose **Report a vulnerability**. Include the steps to reproduce and the version (`compress-media --version`). You should get a reply within a few days.

Examples of issues we want to hear about:

- ways around the login, the rate limit, or the webhook address checks;
- path traversal through uploaded file names or CLI arguments;
- access to files outside `WORK_DIR`;
- command injection into ffmpeg, Ghostscript or other tools;
- crashes triggered by crafted media or PDFs.
