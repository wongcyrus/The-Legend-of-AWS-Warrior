using System.Net;
using System.Text.RegularExpressions;
using Amazon.DynamoDBv2;
using Amazon.Lambda.APIGatewayEvents;
using Amazon.Lambda.Core;
using ProjectTestsLib.Helper;
using ServerlessAPI.Helper;

namespace ServerlessAPI.Functions;

public class ResetMarksFunction
{
    private readonly Func<string, Task<string?>>? resolveEmail;
    private readonly Func<string, Task>? resetMarks;

    public ResetMarksFunction() { }

    public ResetMarksFunction(Func<string, Task<string?>> resolveEmail, Func<string, Task> resetMarks)
    {
        this.resolveEmail = resolveEmail;
        this.resetMarks = resetMarks;
    }

    public async Task<APIGatewayHttpApiV2ProxyResponse> ResetMarksHandler(
        APIGatewayProxyRequest request, ILambdaContext context)
    {
        if (string.Equals(request.HttpMethod, "OPTIONS", StringComparison.OrdinalIgnoreCase))
        {
            return ApiResponse.CreateResponseMessage(HttpStatusCode.OK, "Options request");
        }
        if (!string.Equals(request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase))
        {
            var response = ApiResponse.CreateResponseMessage(HttpStatusCode.MethodNotAllowed, "Use POST to reset marks.");
            response.Headers["Allow"] = "POST, OPTIONS";
            return response;
        }

        var apiKey = request.Headers?.FirstOrDefault(header =>
            string.Equals(header.Key, "x-api-key", StringComparison.OrdinalIgnoreCase)).Value;
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            return ApiResponse.CreateResponseMessage(HttpStatusCode.Unauthorized, "Set your API key first.");
        }

        try
        {
            var email = resolveEmail != null
                ? await resolveEmail(apiKey)
                : await new ApiKeyHelper(context.Logger).GetEmailFromApiKey(apiKey);
            if (string.IsNullOrWhiteSpace(email) ||
                !Regex.IsMatch(email, @"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$"))
            {
                return ApiResponse.CreateResponseMessage(HttpStatusCode.Unauthorized, "Invalid API key.");
            }

            if (resetMarks != null)
            {
                await resetMarks(email);
            }
            else
            {
                using var client = new AmazonDynamoDBClient();
                await new DynamoDB(client, context.Logger).ResetMarks(email);
            }
            return ApiResponse.CreateResponse(HttpStatusCode.OK, new { IsSuccess = true });
        }
        catch (Exception)
        {
            context.Logger.LogError("Marks reset failed. Some records may already have been removed; the student can retry.");
            return ApiResponse.CreateResponseMessage(HttpStatusCode.InternalServerError,
                "Unable to finish resetting marks. Please try again.");
        }
    }
}
