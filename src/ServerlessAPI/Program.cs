using System.Text.Json;
using Amazon;
using Amazon.DynamoDBv2;
using Microsoft.AspNetCore.StaticFiles;
using ProjectTestsLib.Helper;
using ServerlessAPI.Helper;


var builder = WebApplication.CreateBuilder(args);

//Logger
builder.Logging
        .ClearProviders().AddConsole();
// .AddJsonConsole();

string region = Environment.GetEnvironmentVariable("AWS_REGION") ?? RegionEndpoint.USEast2.SystemName;

// Add services to the container.
builder.Services
        .AddCors(options =>
        {
                options.AddPolicy("AllowAnyOrigins", builder =>
                {
                        builder.AllowAnyOrigin()
                                .AllowAnyMethod()
                                .AllowAnyHeader();
                });
        })
        .AddSingleton<IAmazonDynamoDB>(new AmazonDynamoDBClient(RegionEndpoint.GetBySystemName(region)))        
        .AddSingleton<FileExtensionContentTypeProvider>()
        .AddSingleton<AmazonS3>()
        .AddSingleton<DynamoDB>()
        .AddSingleton<AwsAccount>()
        .AddSingleton<AwsBedrock>()
        .AddScoped<TestRunner>()
        .AddControllers()
        .AddJsonOptions(options =>
        {
                options.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        })
        .AddXmlDataContractSerializerFormatters();



// Add AWS Lambda support. When running the application as an AWS Serverless application, Kestrel is replaced
// with a Lambda function contained in the Amazon.Lambda.AspNetCoreServer package, which marshals the request into the ASP.NET Core hosting framework.
builder.Services.AddAWSLambdaHosting(LambdaEventSource.HttpApi);


var app = builder.Build();

app.UseHttpsRedirection();
app.UseAuthorization();
app.UseCors("AllowAnyOrigins");
app.MapControllers();

app.MapGet("/", () => "Welcome to running ASP.NET Core Minimal API on AWS Lambda");

app.Run();
