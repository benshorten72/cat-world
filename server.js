import multer from 'multer';
import express from 'express';
import crypto from 'crypto'

import { validateBuffers } from './uploadMiddleware.js';
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { marshall } from "@aws-sdk/util-dynamodb";

import dotenv from 'dotenv'
import sharp from 'sharp'
import { time } from 'console';

dotenv.config();

const randomImageName = (bytes = 32) => crypto.randomBytes(16).toString('hex')

const BUCKET_NAME = process.env.BUCKET_NAME;
const BUCKET_REGION = process.env.BUCKET_REGION;
const BUCKET_ACCESS_KEY = process.env.BUCKET_ACCESS_KEY;
const BUCKET_SECRET_KEY = process.env.BUCKET_SECRET_KEY;

const image_height = 150;
const image_width = 150;

const s3 = new S3Client({
  credentials: {
    accessKeyId: BUCKET_ACCESS_KEY,
    secretAccessKey: BUCKET_SECRET_KEY
  },
  region: BUCKET_REGION
});

const db_client = new DynamoDBClient({
  credentials: {
    accessKeyId: BUCKET_ACCESS_KEY,
    secretAccessKey: BUCKET_SECRET_KEY
  },
  region: BUCKET_REGION
});

const ddb = DynamoDBDocumentClient.from(db_client);

const app = express();
app.use(express.json())
const PORT = 3000;

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
const multi_upload = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
])

const verification = {
  Pending: 'PENDING',
  Flagged: 'FLAGGED',
  Verified: 'VERIFIED'
}

// Serve everything in the "public" folder
app.use(express.static('public'));
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

app.post('/api/posts', multi_upload, async (req, res) => {
  console.log("req.body", req.body)
  console.log("req.file", req.file)
  //Lat and long maybe in req.body
  const imageFile = req.files.image?.[0];
  const audioFile = req.files.audio?.[0];
  try {
    await validateBuffers(req.files);


    //This is what we need to send to s3
    const buffer = await sharp(imageFile.buffer).resize({ height: image_height, width: image_width }).toBuffer();
    const key = randomImageName();
    const imageKey = "photos/" + key
    const params = {
      Bucket: BUCKET_NAME,
      Key: imageKey,
      Body: buffer,
      ContentType: imageFile.mimetype
    }
    const command = new PutObjectCommand(params);
    await s3.send(command);
    const audioKey = "audio/" + key + ".mp3"
    const audioParams = {
      Bucket: BUCKET_NAME,
      Key: audioKey,
      Body: audioFile.buffer,
      ContentType: audioFile.mimetype
    }
    const audioCommand = new PutObjectCommand(audioParams);
    await s3.send(audioCommand);
    const catName = req.body.caption
    const table_entry = {
      TableName: "cat-world-table",
      Item: {
        key,
        audioKey,
        catName,
        long: 30,
        lat: 30,
        time: new Date().toISOString(),
        imageVerified: verification.Pending,
        audioVerified: verification.Pending
      }
    }
    // I need to strip photos/ from lambda function whne looking up table
    console.log("Entry:", table_entry)
    await ddb.send(new PutCommand(table_entry))
    res.send({});
  } catch (err) {
    res.status(400).send({ error: err.message });
  }
})


//Scan all table, use the image names(keys) to make public accessible URLS, add them to in memory table and add URLs to them
app.get('/api/posts', async (req, res) => {
  const scan = new ScanCommand({
  TableName: "cat-world-table",
  FilterExpression: "audioVerified = :verified AND imageVerified = :verified",
  ExpressionAttributeValues: {
    ":verified": "VERIFIED"
  }
});
  let catImageUrls=[]
  let catAudioUrls=[]
  const cat_data = await ddb.send(scan);  
    const items = cat_data.Items
    const shuffled = items.sort(()=> 0.5 - Math.random());
    const selectedCats = shuffled.slice(0,20);
     for (const cat of selectedCats) {
    const getObjectParams = {
      Bucket: BUCKET_NAME,
      Key: "photos/" + cat.key
    }
    const getObjectParamsAudio = {
      Bucket: BUCKET_NAME,
      Key: cat.audioKey
    }
    const command = new GetObjectCommand(getObjectParams);
    const commandAudio = new GetObjectCommand(getObjectParamsAudio);
    const url = await getSignedUrl(s3, command, { expiresIn: 3600 })
    const urlAudio = await getSignedUrl(s3, commandAudio, { expiresIn: 3600 })
    catAudioUrls.push(urlAudio)
    catImageUrls.push(url)

  }
    let returnDict = {payload:[]}

    for (let i = 0; i < selectedCats.length;i++){
        returnDict.payload[i]={
          lat: selectedCats[i].lat,
          lng: selectedCats[i].long,
          img_file: catImageUrls[i],
          snd_file: catAudioUrls[i],
          catName: selectedCats[i].catName
        }}
  res.send(returnDict)
  console.log("Returning dictonary", returnDict)
})


app.post('/api/verification', async (req, res) => {
  console.log(req.body)
  if ("key" in req.body && req.body.key !== undefined) {
    try {
      const dbCommand = new GetCommand({
        TableName: "cat-world-table",
        Key: { key: req.body.key }
      });

      const dbResponse = await db_client.send(dbCommand);
      if (!("Item" in dbResponse)) {
        console.log("No assoicated key")
        res.send("No associated key")
        return
      }
      const imageVer = dbResponse?.Item?.imageVerified;
      const audioVer = dbResponse?.Item?.audioVerified;
      const dataTime = dbResponse?.Item?.time;
      const time = new Date(dataTime);
      console.log(dataTime)
      console.log(dbResponse)
      const now = new Date();

      const diffMs = now - time;
      const diffMinutes = diffMs / 1000 / 60;

      if (imageVer === verification.Verified && audioVer === verification.Verified) {
        res.send({ verifcationStatus: verification.Verified });
        console.log("Verification complete:", dbResponse.Item);
      } else if (imageVer === verification.Flagged || audioVer === verification.Flagged) {
        console.log("Verification failed. Deleting obejct");
        res.send({ verifcationStatus: verification.Flagged });
      } else {
        res.send({ verifcationStatus: verification.Pending });
        console.log("Verification pending");
        console.log(diffMinutes)
        if (diffMinutes > 2) {
          console.log("Item is pending time is expired, deleting")
        }
      }
    } catch (error) {
      console.error("DynamoDB error:", error);
      res.status(500).send("Internal Server Error");
    }
  } else {
    res.status(400).send("Bad Request");
  }
});
