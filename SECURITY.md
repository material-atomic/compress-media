# Security policy

## Deployment model

Compress Media is built to run **on your own machine or a trusted private network**. The web server has **no authentication**, and anyone who can reach its port can:

- upload files and use your CPU;
- download results while they are kept, which is 3 hours by default.

With `STORAGE=s3`, the app's credentials only need `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload` and `s3:ListMultipartUploadParts` on the bucket, plus `s3:PutBucketCORS` if you use `S3_SETUP_CORS`. Scope them to that one bucket or prefix. Browsers only ever receive short-lived presigned URLs, never the credentials.

The defaults reflect this. The server binds to `127.0.0.1`, and Docker Compose publishes the port on `127.0.0.1` only. If you expose it more widely, put it behind a reverse proxy with authentication and consider setting `MAX_UPLOAD_MB`.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private reporting instead: go to the **Security** tab and choose **Report a vulnerability**. Include the steps to reproduce and the version (`compress-media --version`). You should get a reply within a few days.

Examples of issues we want to hear about:

- path traversal through uploaded file names or CLI arguments;
- access to files outside `WORK_DIR`;
- command injection into ffmpeg or other tools;
- crashes triggered by crafted media.
