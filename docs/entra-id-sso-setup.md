# Setting Up Microsoft Entra ID (Azure AD) SSO for Midstream

This guide walks through creating and configuring a Microsoft Entra ID App Registration in Azure, storing the client secret in Kubernetes, configuring Midstream's Helm values for both the Console and your domain(s), and verifying single sign-on.

---

## How Entra ID SSO Works in Midstream

1. **The Console initiates the OAuth 2.0 + PKCE flow** against `https://login.microsoftonline.com/<tenantId>/oauth2/v2.0` requesting the `openid email profile` scopes and receives an ID token at `<console.url>/api/auth/sso/entra/callback`.
2. **Each domain verifies the ID token independently** against the tenant's public signing keys (`iss`, `aud`, `exp`, `iat`, `nonce`, and `tid`), extracts the user's immutable `oid` and `email` (or `preferred_username`), and provisions or links their Midstream account.
3. **Secrets stay only in the Console's namespace:** Only the Console exchanges the authorization code (requiring the Entra client secret). Domain control planes only need the public `tenantId` and `clientId` to verify the ID token signature and claims.

---

## Prerequisites

- Permission in Microsoft Entra ID to register applications (e.g., `Application Developer` or `Cloud Application Administrator`).
- [Azure CLI (`az`)](https://learn.microsoft.com/cli/azure/install-azure-cli) installed (or access to the Azure Portal).
- `kubectl` and `helm` (3.12+) configured against your Kubernetes cluster.
- Your Midstream Console's public URL (without a trailing slash), e.g., `https://midstream.example.com` (or `http://localhost:8787` for local port-forward testing).

---

## Step 1: Set Environment Variables and Sign In to Azure

```bash
export NS=midstream                                  # Kubernetes namespace where the Console runs
export RELEASE=midstream                             # Helm release name
export CONSOLE_URL="https://midstream.example.com"   # Console URL (no trailing slash)
export REDIRECT_URI="$CONSOLE_URL/api/auth/sso/entra/callback"
export APP_NAME="Midstream Console"
```

Sign in to Azure and get your Entra ID Tenant ID:

```bash
az login
export TENANT_ID="$(az account show --query tenantId --output tsv)"
echo "Tenant ID: $TENANT_ID"
```

---

## Step 2: Create and Configure the Entra ID App Registration

You can create the App Registration using either the **Azure CLI (Option A)** or the **Azure Portal (Option B)**.

### Option A: Using the Azure CLI

1. **Create the single-tenant Web App Registration with the callback Redirect URI**:

   ```bash
   export CLIENT_ID="$(az ad app create \
     --display-name "$APP_NAME" \
     --sign-in-audience AzureADMyOrg \
     --web-redirect-uris "$REDIRECT_URI" \
     --query appId \
     --output tsv)"
   echo "Client ID: $CLIENT_ID"
   ```

2. **Add the optional `email` claim to ID tokens** (so Entra includes the `email` claim in the ID token in addition to `preferred_username`) and ensure the Microsoft Graph `User.Read` delegated permission (`e1fe6dd8-ba31-4d61-89e7-88639da4683d`) is configured:

   ```bash
   APP_OBJECT_ID="$(az ad app show --id "$CLIENT_ID" --query id --output tsv)"

   az rest \
     --method PATCH \
     --uri "https://graph.microsoft.com/v1.0/applications/$APP_OBJECT_ID" \
     --headers "Content-Type=application/json" \
     --body '{
       "optionalClaims": {
         "idToken": [
           {
             "name": "email",
             "essential": false
           }
         ]
       },
       "requiredResourceAccess": [
         {
           "resourceAppId": "00000003-0000-0000-c000-000000000000",
           "resourceAccess": [
             {
               "id": "e1fe6dd8-ba31-4d61-89e7-88639da4683d",
               "type": "Scope"
             }
           ]
         }
       ]
     }'
   ```

3. **Create the Service Principal in your tenant** (and optionally grant admin consent if your tenant restricts user consent):

   ```bash
   az ad sp create --id "$CLIENT_ID"

   # Optional: Grant tenant-wide admin consent for User.Read (requires Global/Privileged Role Admin)
   # az ad app permission admin-consent --id "$CLIENT_ID"
   ```

---

### Option B: Using the Azure Portal

1. Open the [Azure Portal](https://portal.azure.com) and navigate to **Microsoft Entra ID › App registrations › New registration**.
2. Configure the registration:
   - **Name**: `Midstream`
   - **Supported account types**: *Accounts in this organizational directory only (Single tenant)*
   - **Redirect URI**: Select platform **Web** and enter:
     ```text
     https://midstream.example.com/api/auth/sso/entra/callback
     ```
     *(Replace `https://midstream.example.com` with your `console.url`, with no trailing slash before `/api`.)*
3. Click **Register**.
4. From the **Overview** blade, copy the **Application (client) ID** and **Directory (tenant) ID**:
   ```bash
   export TENANT_ID="<your-directory-tenant-id>"
   export CLIENT_ID="<your-application-client-id>"
   ```
5. Go to **Token configuration › Add optional claim**:
   - Select token type **ID**, check **`email`**, and click **Add** (leave "Turn on the Microsoft Graph email permission" checked if prompted).
6. Go to **API permissions**:
   - Verify `Microsoft Graph › User.Read` (Delegated) is present. If your tenant requires administrator consent for apps, click **Grant admin consent for \<Tenant\>**.

---

## Step 3: Create the Client Secret and Kubernetes Secret

Generate a client secret for the App Registration and store it directly in a Kubernetes Secret (`$RELEASE-sso`) in the Console's namespace without printing the secret to your terminal.

### If using the Azure CLI:

```bash
# Generate a 1-year client secret and pipe it directly into the Kubernetes Secret
CLIENT_SECRET="$(az ad app credential reset \
  --id "$CLIENT_ID" \
  --append \
  --display-name "midstream-console" \
  --years 1 \
  --query password \
  --output tsv)"

kubectl -n "$NS" create secret generic "$RELEASE-sso" \
  --from-literal=entra-client-secret="$CLIENT_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -

unset CLIENT_SECRET
```

### If using the Azure Portal:

1. In your App Registration, go to **Certificates & secrets › Client secrets › New client secret**.
2. Enter a description (e.g., `midstream-console`), choose an expiration, and click **Add**.
3. Copy the secret **Value** (not the Secret ID) and create the Kubernetes Secret:

   ```bash
   read -rs -p "Paste Entra client secret value: " CLIENT_SECRET; echo
   kubectl -n "$NS" create secret generic "$RELEASE-sso" \
     --from-literal=entra-client-secret="$CLIENT_SECRET" \
     --dry-run=client -o yaml | kubectl apply -f -
   unset CLIENT_SECRET
   ```

---

## Step 4: Configure Helm Values

Update your `midstream-values.yaml` with `console.url`, `console.sso.entra`, and `auth.sso.entra`.

### Single-Release Deployment (Console + Domain in the Same Release)

When a single Helm release deploys both the domain control plane and the Console, `auth.sso.entra` automatically inherits `tenantId` and `clientId` from `console.sso.entra` if left empty, or you can specify both explicitly:

```yaml
auth:
  sso:
    entra:
      enabled: true
      tenantId: "<TENANT_ID>"
      clientId: "<CLIENT_ID>"
    # First-time sign-in behavior:
    #   open    - automatically creates a Midstream account in the "All Users" group
    #   invited - requires an administrator to invite or pre-create the user first
    firstSignIn: open
    # Optional: restrict SSO sign-ins to specific email domains (empty allows any in the tenant)
    allowedEmailDomains: []       # e.g., ["example.com"]
  # Whether non-admin users can still sign in with a password (admins always can)
  passwordSignIn: true

console:
  url: "https://midstream.example.com"
  sso:
    entra:
      enabled: true
      tenantId: "<TENANT_ID>"
      clientId: "<CLIENT_ID>"
      clientSecretSecret:
        name: midstream-sso       # "$RELEASE-sso" created in Step 3
        key: entra-client-secret
```

Or generate the snippet with environment variables expanded:

```bash
cat >> midstream-values.yaml <<VALUES
auth:
  sso:
    entra:
      enabled: true
      tenantId: $TENANT_ID
      clientId: $CLIENT_ID
    firstSignIn: open
    allowedEmailDomains: []
  passwordSignIn: true

console:
  url: $CONSOLE_URL
  sso:
    entra:
      enabled: true
      tenantId: $TENANT_ID
      clientId: $CLIENT_ID
      clientSecretSecret:
        name: $RELEASE-sso
        key: entra-client-secret
VALUES
```

### Multi-Domain Deployment (Additional Domains in Separate Releases)

If you have additional domain releases (`console.enabled: false`), those domains **do not** need the `$RELEASE-sso` Secret—only the same `tenantId` and `clientId`:

```yaml
# domain-b-values.yaml
console:
  enabled: false

auth:
  sso:
    entra:
      enabled: true
      tenantId: "<TENANT_ID>"
      clientId: "<CLIENT_ID>"
    firstSignIn: open
```

---

## Step 5: Apply the Configuration

Install or upgrade your Helm release:

```bash
helm upgrade --install "$RELEASE" charts/midstream \
  -n "$NS" \
  -f midstream-values.yaml
```

> **Note:** If you run multiple Console replicas (`console.replicas > 1`), ensure your Ingress or Gateway route uses sticky sessions (session affinity) so the `/api/auth/sso/entra/callback` request lands on the replica holding the in-flight PKCE state.

---

## Step 6: Verify Entra ID Sign-In

1. **Check the domain's active sign-in providers via the API**:

   ```bash
   kubectl -n "$NS" port-forward "svc/$RELEASE-control-plane-app-api" 6065:6065 &
   curl -s http://localhost:6065/auth/session | python3 -m json.tool
   ```

   Confirm `"providers"` includes `{"id": "entra", "type": "sso", "label": "Microsoft"}`.

2. **Sign in through the Console**:
   - Open `$CONSOLE_URL` in your browser.
   - Click **Sign in with Microsoft**.
   - Complete the Microsoft Entra ID sign-in prompt; you will be redirected back to `$CONSOLE_URL/api/auth/sso/entra/callback` and signed in to every enabled domain.

3. **Adjust sign-in policies at runtime (optional)**:
   - Once signed in as an Administrator, go to **Settings › Sign-in** in the Console to toggle Entra ID, switch **First sign-in** between `open` and `invited`, restrict **Allowed email domains**, or disable **Password sign-in** for non-administrators without redeploying the chart.
