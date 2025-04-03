using Amazon;
using Amazon.BedrockRuntime;
using Amazon.BedrockRuntime.Model;
using Amazon.Lambda.Core;
using ProjectTestsLib.Helper;

namespace ServerlessAPI.Helper;
public class AwsBedrock
{
    private readonly ILambdaLogger logger;
    private DynamoDB dynamoDB;

    public AwsBedrock(ILambdaLogger logger, DynamoDB dynamoDB)
    {
        this.logger = logger;
        this.dynamoDB = dynamoDB;
    }


    public async Task<string?> RandomNPCConversation()
    {
        string prompt = """
           Write a short sentence in less than 20 words to the AWS warrior to encorage him to fight the monster.
        """;
        Random random = new Random();
        int randomNumber = random.Next(1, 6);
        return await InvokeLargeLanguageModelAsync(prompt + "->" + randomNumber, "amazon.nova-pro-v1:0");
    }

    public async Task<string?> RewriteInstruction(string instruction)
    {
        string prompt =
 """
 <Message>
 """ + instruction +
@"""
</Message>
Rewrite the message with the tone as a girl in age 20 and ask for help from the AWS warrior.            
        """;

        return await InvokeLargeLanguageModelAsync(prompt, "amazon.nova-lite-v1:0");
    }


    private async Task<string?> InvokeLargeLanguageModelAsync(string prompt, string modelId = "amazon.nova-micro-v1:0")
    {
        string? cachedResult = await dynamoDB.GetCachedInstruction(prompt);
        if (!string.IsNullOrEmpty(cachedResult))
        {
            return cachedResult;
        }

        string? generatedText;
        var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        try
        {
            logger.Log($"InvokeModelAsync {modelId} with prompt\n: {prompt}");

            var client = new AmazonBedrockRuntimeClient(RegionEndpoint.USEast1);
            var request = new ConverseRequest
            {
                ModelId = modelId,
                Messages = new List<Message>
                {
                    new Message
                    {
                        Role = ConversationRole.User,
                        Content = [new ContentBlock { Text = prompt }]
                    }
                },
                InferenceConfig = new InferenceConfiguration()
                {
                    MaxTokens = 1024,
                    Temperature = 0.6F,
                    TopP = 0.7F
                }
            };
            var response = await client.ConverseAsync(request,cts.Token);
            generatedText = response?.Output?.Message?.Content?[0]?.Text ?? "";
        }
        catch (TaskCanceledException)
        {
            logger.LogError("InvokeModelAsync timed out after 20 seconds!");
            return string.Empty;
        }
        catch (AmazonBedrockRuntimeException e)
        {
            logger.LogError("AmazonBedrockRuntimeException: " + e.Message);
            return null;
        }

        if (!string.IsNullOrEmpty(generatedText))
        {
            await dynamoDB.SaveCachedInstruction(prompt, generatedText);
        }
        return generatedText;
    }
}