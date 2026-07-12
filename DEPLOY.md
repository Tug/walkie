# Deploying walkie on Cloud Run (Google Workspace auth)

For personal use, walkie runs on your own machine with `AUTH_MODE=token` and needs none of
this. This guide is for hosting it on org infra (Juisci-style) behind Google Workspace sign-in.

## What changes in the cloud

A Cloud Run container has no tmux, no multiclaude daemon and no local Claude login, so:

- The fleet tools (`fleet_status`, `spawn_worker`, `agent_output`, ...) report an unreachable
  fleet unless you point `MULTICLAUDE_BIN` at something meaningful. Cloud deployment is for
  the **voice/MCP gateway and the orchestrator**, not the fleet itself.
- `ask_orchestrator` (Claude Agent SDK) needs `ANTHROPIC_API_KEY` set: metered API billing,
  not a Claude subscription.

## 1. Google OAuth client

In Google Cloud Console (APIs & Services > Credentials), create an OAuth client ID of type
"Web application":

- Authorized redirect URI: `https://<your-domain>/auth/callback`
- Note the client ID and client secret.

## 2. Secrets in Secret Manager

```bash
PROJECT=your-gcp-project
printf '%s' "$GOOGLE_CLIENT_SECRET" | gcloud secrets create walkie-google-client-secret --data-file=- --project $PROJECT
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create walkie-session-secret --data-file=- --project $PROJECT
printf '%s' "$OPENAI_API_KEY"      | gcloud secrets create walkie-openai-api-key --data-file=- --project $PROJECT
printf '%s' "$ANTHROPIC_API_KEY"   | gcloud secrets create walkie-anthropic-api-key --data-file=- --project $PROJECT
```

Grant the runtime service account `roles/secretmanager.secretAccessor` on each.

## 3. Build and deploy

```bash
PROJECT=your-gcp-project
REGION=europe-west4
IMAGE=$REGION-docker.pkg.dev/$PROJECT/walkie/walkie:latest

gcloud artifacts repositories create walkie --repository-format=docker --location=$REGION --project $PROJECT || true
gcloud builds submit --tag $IMAGE --project $PROJECT

gcloud run deploy walkie \
  --image $IMAGE \
  --region $REGION \
  --project $PROJECT \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 2 --memory 512Mi \
  --set-env-vars AUTH_MODE=google,GOOGLE_CLIENT_ID=<client-id>,GOOGLE_ALLOWED_DOMAIN=juisci.com,PUBLIC_URL=https://<your-domain> \
  --set-secrets GOOGLE_CLIENT_SECRET=walkie-google-client-secret:latest,SESSION_SECRET=walkie-session-secret:latest,OPENAI_API_KEY=walkie-openai-api-key:latest,ANTHROPIC_API_KEY=walkie-anthropic-api-key:latest
```

`--allow-unauthenticated` is correct: walkie does its own auth (Google Workspace sign-in,
domain-restricted). Map your custom domain to the service and make sure `PUBLIC_URL` matches
it exactly (it is used for the OAuth redirect URI and Secure cookies).

## 4. How users sign in

- Browser: visit `https://<your-domain>/auth/login` once; a 7-day httpOnly session cookie is
  set, then `/app` and `/voice` work with the token field left empty.
- Mobile app: the post-login page displays the session token; paste it into the app's token
  field (valid 7 days).
- Machine clients (MCP connectors, CI): either a session token, or keep `FLEET_TOKEN` set in
  the environment; it stays accepted as a bearer in google mode for non-human clients.

## Auth modes recap

| | `AUTH_MODE=token` (default) | `AUTH_MODE=google` |
|---|---|---|
| Who | anyone with the shared token | Workspace members of `GOOGLE_ALLOWED_DOMAIN` |
| Setup | one env var | OAuth client + 2 secrets + public URL |
| Session | permanent shared secret | 7-day signed session, per-user email in `sub` |
