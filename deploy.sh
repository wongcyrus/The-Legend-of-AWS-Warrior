SecretHash=$1
if [ -z "$SecretHash" ]; then
    echo "SecretHash is required. Exiting script."
    exit 1
fi

sam build && sam deploy --parameter-overrides "SecretHash=$SecretHash"

WebApiEndpoint=$(aws cloudformation describe-stacks \
    --stack-name CloudProjectMarker \
    --region us-east-1 \
    --no-paginate \
    --no-cli-pager \
    --output text \
--query "Stacks[0].Outputs[?OutputKey=='WebApiEndpoint'].OutputValue")
echo "WebApiEndpoint: $WebApiEndpoint"

KeygenApiEndpoint=$(aws cloudformation describe-stacks \
    --stack-name CloudProjectMarker \
    --region us-east-1 \
    --no-paginate \
    --no-cli-pager \
    --output text \
--query "Stacks[0].Outputs[?OutputKey=='KeygenApiEndpoint'].OutputValue")   


# Check if WebApiEndpoint is set and not empty
if [ -z "$WebApiEndpoint" ]; then
    echo "WebApiEndpoint is not set or is empty"
    exit 1
fi

echo "export const baseUrl = '$WebApiEndpoint/Prod/';" > web-app/src/Constant.js
sed -i 's|//Prod/|/Prod/|g' web-app/src/Constant.js

echo "export const baseUrl = '$WebApiEndpoint/Prod/';" > web-game/src/constant.js
sed -i 's|//Prod/|/Prod/|g' web-game/src/constant.js


cd web-app
npm i
npm run build
npm run deploy

echo "Web app deployed successfully"
echo "KeygenApiEndpoint"
echo $KeygenApiEndpoint
