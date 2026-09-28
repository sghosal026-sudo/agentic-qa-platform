# Authentication

Include a bearer token in the request header:

```http
Authorization: Bearer <any-token>
```

There is **no token-issuance endpoint** and **no token validation against a user store**. The API only checks that the `Authorization` header is present; any non-empty bearer token is accepted.

The default documented value is `dev-token`, but for local testing you can send any token string.