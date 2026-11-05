# Setting Up Midstream with Azure Blob Storage

This guide walks through creating an Azure Storage account and container, configuring access for Midstream and the Midstream Console, creating the Kubernetes Secrets, verifying the store, and configuring your Helm values.

---

## Prerequisites

- An active Azure subscription and permissions to create storage accounts and role assignments (e.g., `Owner` or `Contributor` + `User Access Administrator` on the resource group, and permission to create service principals in Microsoft Entra ID).
- [Azure CLI (`az`)](https://learn.microsoft.com/cli/azure/install-azure-cli) installed on your machine.
- `kubectl` and `helm` (3.12+) configured against your Kubernetes cluster.

---

## Step 1: Set Environment Variables and Sign In to Azure

Define the names used throughout this guide. Adjust these values to match your environment:

```bash
# Kubernetes / Midstream settings
export NS=midstream                        # Kubernetes namespace for Midstream
export RELEASE=midstream                   # Helm release name
export DOMAIN=domain_a                     # Midstream domain ID
export KAFKA=kafka-bootstrap.kafka.svc.cluster.local:9092
export KAFKA_USER=midstream
export ADMIN_EMAIL=you@example.com

# Azure settings
export LOCATION=eastus                     # Azure region (near your Kubernetes cluster)
export RESOURCE_GROUP=rg-midstream         # Azure resource group name
export ACCOUNT=midstreamlake01             # 3–24 lowercase letters and digits, globally unique in Azure
export CONTAINER=lake                      # 3–63 lowercase letters, digits, and single hyphens
export DESTINATION="abfss://$CONTAINER@$ACCOUNT.dfs.core.windows.net"
```

Sign in to Azure and select your subscription:

```bash
az login
az account set --subscription "<your-subscription-id-or-name>"
```

---

## Step 2: Create the Resource Group, Storage Account, and Container

1. **Create the resource group** (skip if using an existing resource group):

   ```bash
   az group create \
     --name "$RESOURCE_GROUP" \
     --location "$LOCATION"
   ```

2. **Create a StorageV2 account** with Hierarchical Namespace (ADLS Gen2) enabled, public blob access disabled, and TLS 1.2 minimum:

   ```bash
   az storage account create \
     --name "$ACCOUNT" \
     --resource-group "$RESOURCE_GROUP" \
     --location "$LOCATION" \
     --kind StorageV2 \
     --sku Standard_LRS \
     --hns true \
     --allow-blob-public-access false \
     --min-tls-version TLS1_2
   ```

   > **Note:** A hierarchical namespace (`--hns true`) is recommended so external query engines can read Iceberg tables via the `abfss://` DFS endpoint, while Midstream and the Console access the account through its Blob endpoint.

3. **Create the blob container**:

   ```bash
   az storage container-rm create \
     --storage-account "$ACCOUNT" \
     --resource-group "$RESOURCE_GROUP" \
     --name "$CONTAINER"
   ```

4. **Ensure no immutability or legal hold policies are active** (new accounts and containers have none by default, unless enforced by an Azure Policy in your subscription):

   ```bash
   # Verify account-level immutable storage is not enabled (returns null when disabled)
   az storage account show \
     --name "$ACCOUNT" \
     --resource-group "$RESOURCE_GROUP" \
     --query "immutableStorageWithVersioning"

   # Verify container-level immutability and legal hold are false
   az storage container-rm show \
     --storage-account "$ACCOUNT" \
     --resource-group "$RESOURCE_GROUP" \
     --name "$CONTAINER" \
     --query "{hasImmutabilityPolicy:hasImmutabilityPolicy, hasLegalHold:hasLegalHold}"

   # Optional: Disable blob and container soft delete so deleted table files are not retained
   az storage account blob-service-properties update \
     --account-name "$ACCOUNT" \
     --resource-group "$RESOURCE_GROUP" \
     --enable-delete-retention false \
     --enable-container-delete-retention false
   ```
   *(If an unlocked container immutability policy was ever added, remove it with `az storage container immutability-policy delete --account-name "$ACCOUNT" --container-name "$CONTAINER"`.)*

---

## Step 3: Create the Kubernetes Namespace

If your Kubernetes namespace does not exist yet, create it:

```bash
kubectl create namespace "$NS"
```

---

## Step 4: Configure Access and Create the Azure Storage Secrets

Midstream uses two separate identities for security isolation:

| Component | Required Access | Notes |
|---|---|---|
| **Midstream** (control plane, maintenance app, tail app, and runtimes) | Read, write, delete, and list objects (`Storage Blob Data Contributor` or account key) | Commits Iceberg tables, compacts files, and expires snapshots |
| **Midstream Console** | Read and list objects **only** (`Storage Blob Data Reader`) | **Never** give the Console an account key or connection string containing an account key, as account keys always grant write access |

Choose **Option A (Recommended: Service Principals)**, **Option B (Account Key for Midstream + Service Principal for Console)**, or **Option C (AKS Workload Identity)**.

### Option A: Service Principals with RBAC (Recommended)

This creates two service principals scoped strictly to the container and stores their credentials in `$RELEASE-azure` (read/write) and `$RELEASE-console-azure` (read-only) without printing secrets to your terminal:

```bash
# Resolve the resource ID of the target blob container
CONTAINER_SCOPE="$(az storage account show \
  --name "$ACCOUNT" \
  --resource-group "$RESOURCE_GROUP" \
  --query id --output tsv)/blobServices/default/containers/$CONTAINER"

# 1. Create the read-write Service Principal for Midstream (Storage Blob Data Contributor)
{ read -r CLIENT_ID; read -r TENANT_ID; read -r CLIENT_SECRET; } < <(
  az ad sp create-for-rbac \
    --name "midstream-lake-$ACCOUNT" \
    --role "Storage Blob Data Contributor" \
    --scopes "$CONTAINER_SCOPE" \
    --query '[appId, tenant, password]' \
    --output tsv
)

kubectl -n "$NS" create secret generic "$RELEASE-azure" \
  --from-literal=client-id="$CLIENT_ID" \
  --from-literal=tenant-id="$TENANT_ID" \
  --from-literal=client-secret="$CLIENT_SECRET"

# 2. Create the read-only Service Principal for the Console (Storage Blob Data Reader)
{ read -r CLIENT_ID; read -r TENANT_ID; read -r CLIENT_SECRET; } < <(
  az ad sp create-for-rbac \
    --name "midstream-console-$ACCOUNT" \
    --role "Storage Blob Data Reader" \
    --scopes "$CONTAINER_SCOPE" \
    --query '[appId, tenant, password]' \
    --output tsv
)

kubectl -n "$NS" create secret generic "$RELEASE-console-azure" \
  --from-literal=client-id="$CLIENT_ID" \
  --from-literal=tenant-id="$TENANT_ID" \
  --from-literal=client-secret="$CLIENT_SECRET"

unset CLIENT_ID TENANT_ID CLIENT_SECRET
```

> **Note:** Azure RBAC role assignments can take a few minutes to propagate.

---

### Option B: Storage Account Key for Midstream + Read-Only Service Principal for Console

If you prefer to use the storage account's shared key for Midstream's backend apps, create `$RELEASE-azure` with `account-key` (or `connection-string`). Still use a `Storage Blob Data Reader` service principal for the Console so it cannot write to the lake:

```bash
# 1. Create the Midstream secret using the storage account key
kubectl -n "$NS" create secret generic "$RELEASE-azure" \
  --from-literal=account-key="$(az storage account keys list \
    --account-name "$ACCOUNT" \
    --resource-group "$RESOURCE_GROUP" \
    --query '[0].value' \
    --output tsv)"

# 2. Create the read-only Service Principal secret for the Console
CONTAINER_SCOPE="$(az storage account show \
  --name "$ACCOUNT" \
  --resource-group "$RESOURCE_GROUP" \
  --query id --output tsv)/blobServices/default/containers/$CONTAINER"

{ read -r CLIENT_ID; read -r TENANT_ID; read -r CLIENT_SECRET; } < <(
  az ad sp create-for-rbac \
    --name "midstream-console-$ACCOUNT" \
    --role "Storage Blob Data Reader" \
    --scopes "$CONTAINER_SCOPE" \
    --query '[appId, tenant, password]' \
    --output tsv
)

kubectl -n "$NS" create secret generic "$RELEASE-console-azure" \
  --from-literal=client-id="$CLIENT_ID" \
  --from-literal=tenant-id="$TENANT_ID" \
  --from-literal=client-secret="$CLIENT_SECRET"

unset CLIENT_ID TENANT_ID CLIENT_SECRET
```

---

### Option C: AKS Workload Identity (Secretless)

If running on AKS with Workload Identity enabled, you can omit the Kubernetes Secrets (`storage.azure.credentialsSecret: ""` and no `credentialsSecret` on the console storage profile):

1. Create two User-Assigned Managed Identities in Azure:
   - Grant `Storage Blob Data Contributor` on `$CONTAINER_SCOPE` to the Midstream identity.
   - Grant `Storage Blob Data Reader` on `$CONTAINER_SCOPE` to the Console identity.
2. Create Federated Identity Credentials:
   - For the Console identity: trust `system:serviceaccount:$NS:$RELEASE-console`.
   - For the Midstream identity: trust `system:serviceaccount:$NS:$RELEASE-control-plane-app`, `system:serviceaccount:$NS:$RELEASE-maintenance-app`, `system:serviceaccount:$NS:$RELEASE-tail-app`, and each runtime's ServiceAccount (`<runtimeNamePrefix>-<materialization id>-app`). Because Azure limits a managed identity to 20 federated credentials, Option A (Service Principal Secret) is recommended if you plan to run many materializations.
3. Set `kaspr.podLabels`, `kaspr.serviceAccountAnnotations`, `console.podLabels`, and `console.serviceAccountAnnotations` in your Helm values.

---

## Step 5: Verify Azure Storage Access (Optional Pre-Flight Check)

Before installing the Helm chart, you can run Midstream's storage conformance suite against your Azure container using the credentials stored in `$RELEASE-azure` to confirm conditional writes, reads, listings, and deletes work and that RBAC propagation has completed:

```bash
python3 -m venv midstream-check && . midstream-check/bin/activate
python -m pip install midstream-platform

# If using Option A (Service Principal):
export AZURE_CLIENT_ID="$(kubectl -n "$NS" get secret "$RELEASE-azure" -o jsonpath='{.data.client-id}' | base64 --decode)"
export AZURE_TENANT_ID="$(kubectl -n "$NS" get secret "$RELEASE-azure" -o jsonpath='{.data.tenant-id}' | base64 --decode)"
export AZURE_CLIENT_SECRET="$(kubectl -n "$NS" get secret "$RELEASE-azure" -o jsonpath='{.data.client-secret}' | base64 --decode)"

python -m midstream.lakehouse.store.check "$DESTINATION/_check"

unset AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_CLIENT_SECRET
```

*(If using Option B with an account key, export `AZURE_STORAGE_ACCOUNT_KEY` from `{.data.account-key}` instead.)*

---

## Step 6: Create the Kafka and Auth Secrets (If Not Already Created)

If you have not yet created the Kafka and authentication Secrets for the release:

```bash
# Kafka SCRAM password secret
read -rs -p "Kafka password for $KAFKA_USER: " KAFKA_PASSWORD; echo
kubectl -n "$NS" create secret generic "$RELEASE-kafka" \
  --from-literal=password="$KAFKA_PASSWORD"
unset KAFKA_PASSWORD

# Midstream auth secret
FEDERATION_KEY="$(openssl rand -base64 48)"
PROTECTION_KEY="$(openssl rand -base64 48)"
BOOTSTRAP_PASSWORD="$(openssl rand -base64 18)"
kubectl -n "$NS" create secret generic "$RELEASE-auth" \
  --from-literal=signing-key="$(openssl rand -base64 48)" \
  --from-literal=service-token="$(openssl rand -base64 48)" \
  --from-literal=federation-key="$FEDERATION_KEY" \
  --from-literal=protection-key="$PROTECTION_KEY" \
  --from-literal=bootstrap-admin-email="$ADMIN_EMAIL" \
  --from-literal=bootstrap-admin-password="$BOOTSTRAP_PASSWORD"
echo "Bootstrap password for $ADMIN_EMAIL: $BOOTSTRAP_PASSWORD"
unset BOOTSTRAP_PASSWORD
```

---

## Step 7: Write the Helm Values and Install Midstream

Create `midstream-values.yaml` wiring the Azure secrets and `abfss://` destination URI:

```bash
cat > midstream-values.yaml <<VALUES
domain:
  id: $DOMAIN
  name: Domain A

kaspr:
  bootstrapServers: $KAFKA
  authentication:
    type: scram-sha-512
    username: $KAFKA_USER
    passwordSecret:
      secretName: $RELEASE-kafka
      passwordKey: password

storage:
  azure:
    credentialsSecret: $RELEASE-azure

controlPlane:
  settings:
    defaultDestinationUri: $DESTINATION

console:
  storage:
    - name: lake
      scope: $DESTINATION/
      kind: azure
      credentialsSecret: $RELEASE-console-azure
VALUES
```

Install the Helm chart:

```bash
# Install from a checkout of this repository:
helm install "$RELEASE" charts/midstream -n "$NS" -f midstream-values.yaml

# Or install from the published OCI chart:
# helm install "$RELEASE" oci://ghcr.io/vmirz/charts/midstream --version <version> -n "$NS" -f midstream-values.yaml
```

---

## Step 8: Verify the Deployment

1. **Wait for the Kaspr apps to become Ready**:

   ```bash
   kubectl -n "$NS" get kasprapp -w
   ```

2. **Run the store conformance check from inside the control-plane pod**:

   ```bash
   kubectl -n "$NS" exec "$RELEASE-control-plane-app-0" -c kaspr -- \
     python -m midstream.lakehouse.store.check "$DESTINATION/_check"
   ```

3. **Confirm the Console loaded the Azure storage profile**:

   ```bash
   kubectl -n "$NS" logs "deploy/$RELEASE-console" | grep 'storage profile'
   ```
