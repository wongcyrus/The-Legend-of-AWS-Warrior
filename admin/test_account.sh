aws_account_number=646068970548
aws_access_key_id=
aws_secret_access_key=
aws_session_token=

# for i in $(seq 1 20); do
#   email="t-cywong${i}@stu.vtc.edu.hk"
#   aws dynamodb put-item \
#     --table-name CloudProjectMarker-AwsAccountTable-160W5ZEFD9QSA \
#     --item '{
#         "User": {"S": "'"${email}"'"},
#         "AccessKeyId": {"S": "${aws_access_key_id}"},
#         "AwsAccountNumber": {"S": "${aws_account_number}"},
#         "SecretAccessKey": {"S": "#{aws_secret_access_key}"},
#         "SessionToken": {"S": "${aws_session_token}"},
#         "Time": {"S": "20241015015143"}
#     }'
# done

for i in $(seq 1 20); do
  email="t-cywong${i}@stu.vtc.edu.hk"
  aws dynamodb delete-item \
    --table-name CloudProjectMarker-AwsAccountTable-160W5ZEFD9QSA \
    --key '{
        "User": {"S": "'"${email}"'"}
    }'
done