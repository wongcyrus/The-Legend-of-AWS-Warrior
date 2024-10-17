table_name="CloudProjectMarker-FailedTestTable-O1M3M53HOHTW"
# Initialize the ExclusiveStartKey to empty
exclusive_start_key=""

while :; do
    # Scan the table with pagination
    if [ -z "$exclusive_start_key" ]; then
        scan_output=$(aws dynamodb scan --table-name "$table_name" --projection-expression "#usr,TestTime" --expression-attribute-names '{"#usr": "User"}' --output json)
    else
        scan_output=$(aws dynamodb scan --table-name "$table_name" --exclusive-start-key "$exclusive_start_key" --projection-expression "#usr,TestTime" --expression-attribute-names '{"#usr": "User"}' --output json)
    fi

    # Extract the keys of each item
    students=$(echo $scan_output | jq -c '.Items[] | {email:.User.S,test_time:.TestTime.S}')

    # Prepare batch delete items
    batch_items=""
    count=0
    for student in $students; do
        email=$(echo "$student" | jq -r '.email')
        test_time=$(echo "$student" | jq -r '.test_time')
        batch_items="$batch_items{\"DeleteRequest\": {\"Key\": {\"User\": {\"S\": \"$email\"}, \"TestTime\": {\"S\": \"$test_time\"}}}},"
        count=$((count + 1))

        # If batch size reaches 25, send the batch request
        if [ $count -eq 25 ]; then
            batch_items="[${batch_items%,}]"
            aws dynamodb batch-write-item --request-items "{\"$table_name\": $batch_items}"
            batch_items=""
            count=0
        fi
    done

    # Send any remaining items in the batch
    if [ $count -gt 0 ]; then
        batch_items="[${batch_items%,}]"
        aws dynamodb batch-write-item --request-items "{\"$table_name\": $batch_items}"
    fi

    # Check if there are more items to scan
    exclusive_start_key=$(echo $scan_output | jq -r '.LastEvaluatedKey')
    if [ "$exclusive_start_key" == "null" ]; then
        break
    fi
done
