import { RekognitionClient, DetectModerationLabelsCommand, DetectLabelsCommand, DetectTextCommand } from "@aws-sdk/client-rekognition";
import { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } from "@aws-sdk/client-transcribe";
import { Filter } from 'bad-words';
import { DynamoDBClient, UpdateItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from '@aws-sdk/util-dynamodb';
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";



export const handler = async (event) => {
    const record = event.Records[0];
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    const dbKey = key.split('/').pop();
    const dbKeySanitsied = dbKey.replace(/\.mp3$/, '');
    const verification = {
        Pending: 'PENDING',
        Flagged: 'FLAGGED',
        Verified: 'VERIFIED'
    }
    const deleteKeyCompletely = async (sanitisedDBKey, audioBool) => {
        const bucketName = "cat-world";
        const s3Client = new S3Client({});
        const ddbClient = new DynamoDBClient({});
        console.log(`Deleting ${sanitisedDBKey} from S3 and DynamoDB...`);

        let bucketKey = audioBool
            ? `audio/${sanitisedDBKey}.mp3`
            : `photos/${sanitisedDBKey}`;

        // Delete from S3
        try {
            console.log("Deleting from S3:", bucketKey);
            const deleteS3Command = new DeleteObjectCommand({
                Bucket: bucketName,
                Key: bucketKey,
            });
            const s3Response = await s3Client.send(deleteS3Command);
            console.log(`✅ Deleted from S3: ${bucketKey}`, JSON.stringify(s3Response, null, 2));
        } catch (err) {
            console.error("❌ Failed to delete from S3:", err);
        }

        // Delete from DynamoDB
        try {
            console.log("Deleting from DynamoDB:", sanitisedDBKey);
            const deleteDynamoCommand = new DeleteItemCommand({
                TableName: "cat-world-table",
                Key: marshall({ key: sanitisedDBKey }),
            });
            const dynamoResponse = await ddbClient.send(deleteDynamoCommand);
            console.log(`✅ Deleted from DynamoDB: ${sanitisedDBKey}`, JSON.stringify(dynamoResponse, null, 2));
        } catch (err) {
            console.error("❌ Failed to delete from DynamoDB:", err);
        }
        console.log(`Deleted ${sanitisedDBKey} from S3 and DynamoDB.`);
    };

    const updateStatusInDynamo = async (sanitisedDBKey, field, status) => {
        console.log(`Updating ${field} to ${status} for ${sanitisedDBKey}`);
        const ddbClient = new DynamoDBClient({});
        const dbCommand = new UpdateItemCommand({
            TableName: "cat-world-table",
            Key: {
                key: { S: sanitisedDBKey }
            },
            UpdateExpression: `SET ${field} = :status`,
            ExpressionAttributeValues: {
                ":status": { S: status }
            }
        });
    
        try {
            await ddbClient.send(dbCommand);
            console.log(`${field} updated to ${status} for ${sanitisedDBKey}`);
        } catch (err) {
            console.error("DynamoDB update error:", err);
        }
    };
    
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    console.log(`New object: s3://${bucket}/${key}`);
    // function setAsFlagged(){
    //     console.log("Image flaggd as inappropriate. Setting as flagged...");
    // }
    if (key.startsWith('photos/')) {
        console.log("Detected image upload. Running Rekognition...");

        const client = new RekognitionClient({});

        const command = new DetectModerationLabelsCommand({
            Image: {
                S3Object: {
                    Bucket: bucket,
                    Name: key
                }
            }
        });

        try {
            const response = await client.send(command);
            console.log("Moderation Labels:", JSON.stringify(response.ModerationLabels, null, 2));
            if (response.ModerationLabels.length > 0) {
                console.log("Image flagged as inappropriate. Setting as flagged...");

                // Set asflagged in DB
                await updateStatusInDynamo(dbKeySanitsied, "imageVerified", verification.Flagged)
                await deleteKeyCompletely(dbKeySanitsied, false)

                throw new Error("Moderation labels detected")
            }
            const textCommand = new DetectTextCommand({
                Image: {
                    S3Object: {
                        Bucket: bucket,
                        Name: key
                    }
                }
            });
            const textResponse = await client.send(textCommand);

            const allText = textResponse.TextDetections
                .filter(d => d.Confidence > 50)
                .map(d => d.DetectedText.toLowerCase());

            if (allText.length > 0) {
                console.log("Detected text:");
                await updateStatusInDynamo(dbKeySanitsied, "imageVerified", verification.Flagged)
                await deleteKeyCompletely(dbKeySanitsied, false)
                console.log("deleting")
                return {
                    statusCode: 200,
                    body: 'Deleted'
                };
                throw new Error("Text detected.");

            }

            const labelsCommand = new DetectLabelsCommand({
                Image: {
                    S3Object: {
                        Bucket: bucket,
                        Name: key
                    }
                },
                MaxLabels: 10,
                MinConfidence: 20
            });

            const labelsResponse = await client.send(labelsCommand);
            const labels = labelsResponse.Labels.map(label => label.Name.toLowerCase());

            console.log("Detected labels:", labels);

            const hasCat = labels.includes('cat');
            const hasPerson = labels.includes('person');

            if (hasPerson) {
                console.log("Person detected. Setting as flagged...");
                await updateStatusInDynamo(dbKeySanitsied, "imageVerified", verification.Flagged)
                await deleteKeyCompletely(dbKeySanitsied, false)
                console.log("deleting")
                return {
                    statusCode: 200,
                    body: 'Deleted'
                };
                throw new Error("Person Detected.");
            }
            if (!hasCat) {
                console.log("No cat detected. Setting as flagged...");
                await updateStatusInDynamo(dbKeySanitsied, "imageVerified", verification.Flagged)
                await deleteKeyCompletely(dbKeySanitsied, false)
                console.log("deleting")
                return {
                    statusCode: 200,
                    body: 'Deleted'
                };
                throw new Error("No cat in image.");
            }
            console.log("Image Verified, submitting to DB",);
            await updateStatusInDynamo(dbKeySanitsied, "imageVerified", verification.Verified)
            return {
                statusCode: 200,
                body: 'Cat found, all good.'
            };
            // SET verified
        } catch (err) {
            await deleteKeyCompletely(dbKeySanitsied, false)
            console.log("deleting")
            return {
                statusCode: 200,
                body: 'Deleted'
            };
            console.error("Rekognition error:", err);
        }

    } // AUDIO SOUND MUSIC CAT MEOOWWWWWWWWWWWWW NOISE IM MAKING SPACE
    else if (key.startsWith('audio/')) {

        const record = event.Records[0];
        const bucket = record.s3.bucket.name;
        const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
        console.log(`New object: s3://${bucket}/${key}`);
        console.log("Detected audio upload. Running Transcribe...");

        const transcribeClient = new TranscribeClient({});
        const jobName = `transcription-${Date.now()}`;

        const startCommand = new StartTranscriptionJobCommand({
            TranscriptionJobName: jobName,
            LanguageCode: 'en-US',
            Media: {
                MediaFileUri: `s3://${bucket}/${key}`
            }
        });

        try {
            let transcriptUri = ""
            console.log("Starting transcription job...");
            await transcribeClient.send(startCommand);
            console.log("Transcription job started. Waiting...");

            let attempts = 0;
            const maxAttempts = 10;
            const delay = 10000; // 10s

            while (attempts < maxAttempts) {
                const getCommand = new GetTranscriptionJobCommand({
                    TranscriptionJobName: jobName
                });

                const response = await transcribeClient.send(getCommand);
                const status = response.TranscriptionJob.TranscriptionJobStatus;

                console.log(`Attempt ${attempts + 1}/${maxAttempts} - Status: ${status}`);

                if (status === "COMPLETED") {
                    console.log(" Transcription completed");
                    transcriptUri = response.TranscriptionJob.Transcript.TranscriptFileUri;
                    console.log("Transcript URL:", transcriptUri);
                    break;
                } else if (status === "FAILED") {
                    await updateStatusInDynamo(dbKeySanitsied, "audioVerified", verification.Flagged)
                    await deleteKeyCompletely(dbKeySanitsied, true)
                    console.log("deleting")
                    return {
                        statusCode: 200,
                        body: 'Deleted'
                    };
                    throw new Error("Transcription failed.");

                }

                attempts++;
                await sleep(delay);
            }

            if (attempts === maxAttempts) {
                await updateStatusInDynamo(dbKeySanitsied, "audioVerified", verification.Flagged)
                await deleteKeyCompletely(dbKeySanitsied, true)
                console.log("deleting")
                return {
                    statusCode: 200,
                    body: 'Deleted'
                };

                throw new Error("Transcription timed out.");
            }

            const response = await fetch(transcriptUri);
            const data = await response.json();
            // Access the actual transcript text
            const transcriptText = data.results.transcripts.map(t => t.transcript).join(" ").toLowerCase();
            console.log("Transcript Text:", transcriptText);
            const filter = new Filter();
            filter.addWords("not having these on my github no thank youuu")
            if (!filter.isProfane(transcriptText)) {
                console.log("Audio transcribed, no issue found")
                await updateStatusInDynamo(dbKeySanitsied, "audioVerified", verification.Verified)
                // Set as verfiied in DB
            } else {
                //set as flagged in DB
                console.error("Audio transcribed, issue found with profanity")
                await updateStatusInDynamo(dbKeySanitsied, "audioVerified", verification.Flagged)
                await deleteKeyCompletely(dbKeySanitsied, true)
                console.log("deleting")
                return {
                    statusCode: 200,
                    body: 'Deleted'
                };
                throw new Error("Transcription profanity.");

            }

        } catch (err) {
            console.error(" Transcribe error:", err);
            //Flag if issue
        }
    } else {
        console.log("Unsupported file prefix.", key);
        return {
            statusCode: 200,
            body: 'Unsupported file prefix.'
        };
    }

    return {
        statusCode: 200,
        body: 'Processing complete.'
    };
};
