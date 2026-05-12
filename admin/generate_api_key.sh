#!/bin/bash

# Script to generate API key for an email (replicates KeyGenFunction.cs logic)
# Creates API key in API Gateway, associates with usage plan, and stores in DynamoDB
# Usage: ./generate_api_key.sh <email> [--force]
#   --force: Regenerate key even if it already exists

set -e

# Load configuration
source "$(dirname "$0")/../config.sh"

# Check arguments
if [ -z "$1" ]; then
    echo "Usage: $0 <email> [--force]"
    echo "Example: $0 student@vtc.edu.hk"
    exit 1
fi

EMAIL="$1"
FORCE_REGENERATE=false

if [ "$2" == "--force" ]; then
    FORCE_REGENERATE=true
fi

echo "=== Generate API Key ==="
echo "Email: $EMAIL"
echo ""
print_config

# Get stack outputs
echo "Fetching stack information..."
if ! STACK_OUTPUT=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --no-cli-pager 2>&1); then
    echo "Error: Could not fetch stack '$STACK_NAME'"
    echo "$STACK_OUTPUT"
    exit 1
fi

USAGE_PLAN_ID=$(echo "$STACK_OUTPUT" | jq -r '.Stacks[0].Outputs[] | select(.OutputKey=="UsagePlanId") | .OutputValue')
LOOKUP_TABLE=$(echo "$STACK_OUTPUT" | jq -r '.Stacks[0].Outputs[] | select(.OutputKey=="ApiKeyLookupTable") | .OutputValue')

if [ -z "$USAGE_PLAN_ID" ] || [ "$USAGE_PLAN_ID" == "null" ]; then
    echo "Error: Could not find Usage Plan ID in stack outputs"
    exit 1
fi

if [ -z "$LOOKUP_TABLE" ] || [ "$LOOKUP_TABLE" == "null" ]; then
    echo "Error: Could not find ApiKeyLookupTable in stack outputs"
    exit 1
fi

echo "Usage Plan ID: $USAGE_PLAN_ID"
echo "DynamoDB Table: $LOOKUP_TABLE"
echo ""

# Generate encrypted key value matching C# AesOperation.EncryptString logic:
# Key = SHA256(SecretHash), IV = 16 zero bytes, AES-256-CBC, PKCS7 padding, then base64
generate_key_value() {
    local email="$1"
    local secret_hash="${SECRET_HASH:-}"
    
    # If not in env, read from stack parameters
    if [ -z "$secret_hash" ]; then
        if ! secret_hash=$(aws cloudformation describe-stacks \
            --stack-name "$STACK_NAME" --region "$AWS_REGION" --no-cli-pager \
            --query "Stacks[0].Parameters[?ParameterKey=='SecretHash'].ParameterValue" \
            --output text 2>&1); then
            echo "Error: Failed to read SecretHash from stack '$STACK_NAME'" >&2
            echo "$secret_hash" >&2
            return 1
        fi
    fi
    
    if [ -z "$secret_hash" ]; then
        echo "Error: Cannot determine SecretHash for key encryption" >&2
        return 1
    fi

    local aes_key
    aes_key=$(echo -n "$secret_hash" | openssl dgst -sha256 -binary | xxd -p | tr -d '\n')
    local iv="00000000000000000000000000000000"
    echo -n "$email" | openssl enc -aes-256-cbc -K "$aes_key" -iv "$iv" -base64 -A
}

# Check if key already exists for this email
echo "Checking for existing API key..."
if ! EXISTING_KEYS=$(aws apigateway get-api-keys \
    --name-query "$EMAIL" \
    --region "$AWS_REGION" \
    --include-values \
    --no-cli-pager \
    --output json 2>&1); then
    echo "Error fetching existing API keys for '$EMAIL'"
    echo "$EXISTING_KEYS"
    exit 1
fi

EXISTING_KEY_ID=""
EXISTING_KEY_VALUE=""

# Check if any existing key is associated with our usage plan
KEY_COUNT=$(echo "$EXISTING_KEYS" | jq '.items | length')
if [ "$KEY_COUNT" -gt 0 ]; then
    for i in $(seq 0 $((KEY_COUNT - 1))); do
        KEY_ID=$(echo "$EXISTING_KEYS" | jq -r ".items[$i].id")
        KEY_NAME=$(echo "$EXISTING_KEYS" | jq -r ".items[$i].name")
        KEY_VALUE=$(echo "$EXISTING_KEYS" | jq -r ".items[$i].value")
        
        if [ "$KEY_NAME" == "$EMAIL" ]; then
            # Check if this key is in our usage plan
            USAGE_PLAN_CHECK=$(aws apigateway get-usage-plan-key \
                --usage-plan-id "$USAGE_PLAN_ID" \
                --key-id "$KEY_ID" \
                --region "$AWS_REGION" \
                --no-cli-pager 2>/dev/null || echo "")
            
            if [ -n "$USAGE_PLAN_CHECK" ]; then
                EXISTING_KEY_ID="$KEY_ID"
                EXISTING_KEY_VALUE="$KEY_VALUE"
                break
            fi
        fi
    done
fi

if [ -n "$EXISTING_KEY_ID" ] && [ "$FORCE_REGENERATE" = false ]; then
    echo "✓ API key already exists for $EMAIL"
    echo "Key ID: $EXISTING_KEY_ID"
    echo "Key Value: $EXISTING_KEY_VALUE"
    echo ""
    echo "Use --force to regenerate"
    exit 0
fi

if [ "$FORCE_REGENERATE" = true ] && [ -n "$EXISTING_KEY_ID" ]; then
    echo "Force regenerate enabled. Deleting existing key..."
    
    # Delete from DynamoDB first
    aws dynamodb delete-item \
        --table-name "$LOOKUP_TABLE" \
        --key "{\"ApiKey\": {\"S\": \"$EXISTING_KEY_VALUE\"}}" \
        --region "$AWS_REGION" \
        --no-cli-pager > /dev/null 2>&1 || true
    
    # Delete from API Gateway
    aws apigateway delete-api-key \
        --api-key "$EXISTING_KEY_ID" \
        --region "$AWS_REGION" \
        --no-cli-pager > /dev/null 2>&1 || true
    
    echo "✓ Deleted existing key"
fi

# Generate key value
KEY_VALUE=$(generate_key_value "$EMAIL")

# Create API key
echo "Creating API key..."
if ! CREATE_RESPONSE=$(aws apigateway create-api-key \
    --name "$EMAIL" \
    --enabled \
    --value "$KEY_VALUE" \
    --region "$AWS_REGION" \
    --no-cli-pager \
    --output json 2>&1); then
    echo "Error creating API key: $CREATE_RESPONSE"
    exit 1
fi

API_KEY_ID=$(echo "$CREATE_RESPONSE" | jq -r '.id')
API_KEY_VALUE=$(echo "$CREATE_RESPONSE" | jq -r '.value')

echo "✓ Created API key"
echo "Key ID: $API_KEY_ID"
echo "Key Value: $API_KEY_VALUE"

# Associate with usage plan
echo "Associating with usage plan..."
if ! ASSOCIATE_RESPONSE=$(aws apigateway create-usage-plan-key \
    --usage-plan-id "$USAGE_PLAN_ID" \
    --key-id "$API_KEY_ID" \
    --key-type "API_KEY" \
    --region "$AWS_REGION" \
    --no-cli-pager \
    --output json 2>&1); then
    # Check if it's a conflict (already associated)
    if echo "$ASSOCIATE_RESPONSE" | grep -q "ConflictException"; then
        echo "✓ Key already associated with usage plan"
    else
        echo "Error associating with usage plan: $ASSOCIATE_RESPONSE"
        echo "Rolling back: Deleting API key..."
        aws apigateway delete-api-key \
            --api-key "$API_KEY_ID" \
            --region "$AWS_REGION" \
            --no-cli-pager > /dev/null 2>&1
        exit 1
    fi
else
    echo "✓ Associated with usage plan"
fi

# Store in DynamoDB
echo "Storing in DynamoDB..."
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
if ! DYNAMO_RESPONSE=$(aws dynamodb put-item \
    --table-name "$LOOKUP_TABLE" \
    --item "{\"ApiKey\": {\"S\": \"$API_KEY_VALUE\"}, \"Email\": {\"S\": \"$EMAIL\"}, \"CreatedAt\": {\"S\": \"$TIMESTAMP\"}}" \
    --region "$AWS_REGION" \
    --no-cli-pager 2>&1); then
    echo "CRITICAL: Failed to store in DynamoDB: $DYNAMO_RESPONSE"
    echo "Rolling back: Deleting API key..."
    
    # Delete from API Gateway
    aws apigateway delete-api-key \
        --api-key "$API_KEY_ID" \
        --region "$AWS_REGION" \
        --no-cli-pager > /dev/null 2>&1
    
    echo "✗ Rollback complete"
    exit 1
fi

echo "✓ Stored in DynamoDB"
echo ""
echo "=== Success ==="
echo "API Key generated for: $EMAIL"
echo "Key Value: $API_KEY_VALUE"
echo ""
echo "The user can now use this key to access the API."
