using System;
using System.Threading.Tasks;
using Amazon.S3;
using Amazon.S3.Model;
using Amazon.S3.Transfer;
using Microsoft.AspNetCore.StaticFiles;

namespace ProjectTestsLib.Helper;

public class AmazonS3
{
    private readonly FileExtensionContentTypeProvider fileExtensionContentTypeProvider;
    public AmazonS3(FileExtensionContentTypeProvider fileExtensionContentTypeProvider)
    {
        this.fileExtensionContentTypeProvider = fileExtensionContentTypeProvider;
    }

    public async Task<string> UploadFileToS3Async(string filePath, string keyName)
    {
        var client = new AmazonS3Client(Amazon.RegionEndpoint.USEast1);
        var transferUtility = new TransferUtility(client);
        var bucketName = Environment.GetEnvironmentVariable("TEST_RESULT_Bucket")!;

        if (!fileExtensionContentTypeProvider.TryGetContentType(filePath, out var contentType))
        {
            contentType = "text/plain";
        }

        var fileTransferUtilityRequest = new TransferUtilityUploadRequest
        {
            BucketName = bucketName,
            FilePath = filePath,
            StorageClass = S3StorageClass.Standard,
            PartSize = 6291456, // 6 MB.
            Key = keyName,
            ContentType = contentType,
            CannedACL = S3CannedACL.BucketOwnerFullControl
        };

        await transferUtility.UploadAsync(fileTransferUtilityRequest);
        // Geterate the presigned URL for the uploaded file
        var url = GeneratePresignedURL(client, bucketName, keyName);
        return url;
    }

    public static string GeneratePresignedURL(IAmazonS3 client, string bucketName, string objectKey)
    {
        string urlString = string.Empty;
        try
        {
            var request = new GetPreSignedUrlRequest()
            {
                BucketName = bucketName,
                Key = objectKey,
                Expires = DateTime.UtcNow.AddYears(1),
            };
            urlString = client.GetPreSignedURL(request);
        }
        catch (AmazonS3Exception ex)
        {
            Console.WriteLine($"Error:'{ex.Message}'");
        }

        return urlString;
    }
}