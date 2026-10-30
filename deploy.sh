#!/bin/bash

# Main deployment script for CloudProjectMarker stacks
# Usage:
#   ./deploy.sh                          # Deploy active stack (auto-reuses existing SecretHash)
#   ./deploy.sh exam                     # Switch to exam and deploy (auto-reuses existing SecretHash)
#   ./deploy.sh prod                     # Switch to prod and deploy (auto-reuses existing SecretHash)
#   ./deploy.sh exam <SecretHash>        # Deploy exam stack with explicit SecretHash
#   ./deploy.sh <SecretHash>             # Deploy active stack with explicit SecretHash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check if first argument is an environment alias
case "$1" in
    exam|prod|production|test)
        "$SCRIPT_DIR/switch-env.sh" "$1"
        shift
        ;;
esac

# Reload configuration after possible environment switch
source "$SCRIPT_DIR/config.sh"

SecretHash="$1"

# If SecretHash was not passed, try to fetch it from the existing CloudFormation stack
if [ -z "$SecretHash" ]; then
    echo "Fetching existing SecretHash from stack '$STACK_NAME'..."
    SecretHash=$(aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$AWS_REGION" \
        --no-cli-pager \
        --query "Stacks[0].Parameters[?ParameterKey=='SecretHash'].ParameterValue" \
        --output text 2>/dev/null || echo "")
fi

if [ -z "$SecretHash" ]; then
    echo "Error: SecretHash is required for initial stack creation."
    echo "Usage: ./deploy.sh [prod|exam] <SecretHash>"
    exit 1
fi

print_config
echo "SecretHash:  [CONFIGURED]"
echo ""

PARAMETER_OVERRIDES="SecretHash=$SecretHash"
if [ "$ENABLE_VOICE_PRACTICE" = "false" ]; then
    PARAMETER_OVERRIDES="$PARAMETER_OVERRIDES EnableVoicePractice=false"
elif [ "$ENABLE_VOICE_PRACTICE" = "true" ]; then
    VoiceAgentCodeBucket=$(aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$AWS_REGION" \
        --no-cli-pager \
        --query "Stacks[0].Parameters[?ParameterKey=='VoiceAgentCodeBucket'].ParameterValue" \
        --output text 2>/dev/null || echo "")
    if [ -z "$VoiceAgentCodeBucket" ] || [ "$VoiceAgentCodeBucket" = "None" ] || [ "$VoiceAgentCodeBucket" = "voice-agent-not-configured" ]; then
        VoiceAgentCodeBucket=$(aws s3api list-buckets --query "Buckets[?starts_with(Name, 'aws-sam-cli-managed-default-samclisourcebucket-')].Name | [0]" --output text)
    fi
    echo "Packaging VoiceAgent into s3://$VoiceAgentCodeBucket..."
    VOICE_PKG_OUT=$(bash "$SCRIPT_DIR/admin/package_voice_agent.sh" "$VoiceAgentCodeBucket")
    echo "$VOICE_PKG_OUT"
    VoiceAgentCodeKey=$(echo "$VOICE_PKG_OUT" | grep '^VoiceAgentCodeKey=' | cut -d'=' -f2)
    VoiceModelId="${VOICE_MODEL_ID:-us.amazon.nova-2-lite-v1:0}"
    PARAMETER_OVERRIDES="$PARAMETER_OVERRIDES EnableVoicePractice=true VoiceAgentCodeBucket=$VoiceAgentCodeBucket VoiceAgentCodeKey=$VoiceAgentCodeKey VoiceModelId=$VoiceModelId"
fi

sam build && sam deploy \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --capabilities CAPABILITY_IAM \
    --resolve-s3 \
    --parameter-overrides $PARAMETER_OVERRIDES

WebApiEndpoint=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --no-paginate \
    --no-cli-pager \
    --output text \
    --query "Stacks[0].Outputs[?OutputKey=='WebApiEndpoint'].OutputValue")

WebApiEndpoint="${WebApiEndpoint%/}"
echo "WebApiEndpoint: $WebApiEndpoint"

KeygenApiEndpoint=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --no-paginate \
    --no-cli-pager \
    --output text \
    --query "Stacks[0].Outputs[?OutputKey=='KeygenApiEndpoint'].OutputValue")

if [ -z "$WebApiEndpoint" ]; then
    echo "WebApiEndpoint is not set or is empty"
    exit 1
fi

echo "export const baseUrl = '${WebApiEndpoint}/Prod/';" > "$SCRIPT_DIR/web-app/src/Constant.js"
echo "export const baseUrl = '${WebApiEndpoint}/Prod/';" > "$SCRIPT_DIR/web-game/src/constant.js"

cd "$SCRIPT_DIR/web-app"
npm i
REACT_APP_EXAM_MODE="${REACT_APP_EXAM_MODE:-false}" npm run build
npm run deploy

echo ""
echo "=========================================="
echo " ✅ Deployment Complete!"
echo " Stack:             $STACK_NAME"
echo " WebApiEndpoint:    ${WebApiEndpoint}/Prod/"
echo " KeygenApiEndpoint: $KeygenApiEndpoint"
echo "=========================================="
