import axios from 'axios';
import fsp from 'fs/promises';
import fs from 'fs'
import {JWT} from 'google-auth-library'
import {drive} from '@googleapis/drive'
import Bottleneck from 'bottleneck'
import AWS from 'aws-sdk'
const sns=new AWS.SNS({
    region: 'eu-north-1' // Europe/Stockholm
});

const ACCESS_TOKEN= process.env.ACCESS_TOKEN;
const STORE= process.env.STORE_NAME;
const SHOPIFY_URL = `https://${STORE}.myshopify.com/admin/api/2025-07/graphql.json`;

const client_email2=process.env.CLIENT_EMAIL || "";
const formatted_key2=(process.env.PRIVATE_KEY || "").replace(/\\n/g, "\n");
const root_folder_id=process.env.ROOT_FOLDER_ID4 || "";
let client2;
let driveApi;
const BASE_URL = process.env.LINNWORKS_BASE_URL;
const LINNWORKS_APP_ID=process.env.LINNWORKS_APP_ID;
const LINNWORKS_APP_SECRET=process.env.LINNWORKS_APP_SECRET;
const LINNWORKS_API_TOKEN=process.env.LINNWORKS_API_TOKEN;
const M28_24= process.env.EVRI_M28_24;
const M28_48= process.env.EVRI_M28_48;
const DPD_TWO_DAY= process.env.DPD_TWO_DAY;
const DPD_NEXT_DAY= process.env.DPD_NEXT_DAY;
const ABS_EVRI_LINKED_NEXT_DAY= process.env.ABS_EVRI_LINKED_NEXT_DAY;
const ABS_DPD_NEXT_DAY= process.env.ABS_DPD_NEXT_DAY;
const UK_COUNTRY_ID = process.env.UK_COUNTRY_ID;
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;
const limiter = new Bottleneck({
    maxConcurrent: 1,
    minTime: 333,
});
const invoiceFolderPath='./tmp/invoicePrinted';
let pdfCount=0;
let printErrors=[];
let northernSportsOrders=[];
let northernExpressSportsOrders=[];
let amazonSportsOrders=[];
let temuSportsOrders=[];
let otherSportsOrders=[];



const JerseyRegex=  /^JE[1-5]/i;
const numOrderLimiter= new Bottleneck({
    maxConcurrent: 1,
    minTime: 300
});
const getNumOrderWrapper= numOrderLimiter.wrap(async(token, id)=> {
    const res=await axios({
        url: `${BASE_URL}/api/Orders/GetOrderDetailsByNumOrderId?OrderId=${id}`,
        method: 'GET',
        headers: {
            Authorization: token
        }
    });
    if(res.status===200) return res.data;
    return null;
});

const changeShippingMethodLimiter= new Bottleneck({
    maxConcurrent: 1,
    minTime: 333
});

async function authorize() {
  try{
  const res = await axios({
    url: "https://api.linnworks.net/api/Auth/AuthorizeByApplication",
    method: "POST",
    data: {
      ApplicationId: LINNWORKS_APP_ID,
      ApplicationSecret: LINNWORKS_APP_SECRET,
      Token: LINNWORKS_API_TOKEN,
    },
  });
  return res.data;
}catch(err) {
  throw err;
}
}

function isSportsOrder(order) {
    let isEligible=false;
    if(order.GeneralInfo.Status===1 
        && order.GeneralInfo.hasOwnProperty("InvoicePrintError")===false
        && order.GeneralInfo.LabelError.trim().toLowerCase()==="" 
        && (order.GeneralInfo.hasOwnProperty('Marker')?((order.GeneralInfo.Marker===5) ? true : false) : false)
        && order.GeneralInfo.InvoicePrinted===false
        && order.GeneralInfo.HoldOrCancel===false
        && order.GeneralInfo.LabelPrinted===false
        && order.GeneralInfo.PickListPrinted===false
        && order.GeneralInfo.ReceivedDate!=null
        && order.CustomerInfo.Address.Town.trim().toLowerCase()!=="unknown"
        && order.Items.length>0
        && order.ShippingInfo.TotalWeight<=29
    ) return true;
    return false;
}

async function fetchOpenOrders(token) {
    const orders=[];
    let page=1;
    let errorCount=0;
    while(true) {
        let openOrdersRes;
            try{
                openOrdersRes = await axios({
                    url: `${BASE_URL}/api/OpenOrders/GetOpenOrders`,
                    method: "POST",
                    headers: {
                        Authorization: token,
                    },
                    data: {
                        ViewId: 13,
                        LocationId: "3adfb53a-61f1-4c92-9466-9c051f603e48",
                        EntriesPerPage: 500,
                        PageNumber: page,
                    },
                });
            }catch(err) {
                if(errorCount<1 && err?.response?.data?.Message.includes("given key was not present in dictionary")) {
                    await new Promise(r => setTimeout(r, 2000));
                    errorCount++;
                    openOrdersRes = await axios({
                    url: `${BASE_URL}/api/OpenOrders/GetOpenOrders`,
                    method: "POST",
                    headers: {
                        Authorization: token,
                    },
                    data: {
                        ViewId: 13,
                        LocationId: "3adfb53a-61f1-4c92-9466-9c051f603e48",
                        EntriesPerPage: 500,
                        PageNumber: page,
                    },
                });
                }else throw err;
            }
             
            if(openOrdersRes.data.Data.length>0) {
                orders.push(...openOrdersRes.data.Data.filter(order=> isSportsOrder(order)));
                page++;
            }else break;
        }
    console.log(`order: ${orders.length}`);
    return orders;
}


async function processOpenOrders(token, ukTime) {
    const postCodePrefixes = [
    "ab", "fk", "iv", "kw", "pa", "ph", "hs", "ka", "ze", "bt", "im", "po", "tr", "ll"
    ];
    try{
        const shopify_map= await getShopifyData();
        const sportsOrders= await fetchOpenOrders(token);
        if(sportsOrders==null || !Array.isArray(sportsOrders)) throw new Error(`INVALID SPORTS ORDER DATA`);
        for(let i=0; i<sportsOrders.length; i++) {
            let order= sportsOrders[i];
            if(order==null) continue;
            try{
                order= await getNumOrderWrapper(token, order.NumOrderId);
            }catch(err) {
                const errorMsg = (err instanceof Error)
                    ? `ERROR: ${err.message}\nSTACK: ${err.stack}`
                    : `ERROR: ${JSON.stringify(err, null, 2)}`;
                console.log(`FAILED TO GET ORDER DATA FOR: ${order.NumOrderId}`);
                console.log(`err: ${errorMsg}`);
                continue;
            }
            if(order==null || order.NumOrderId==null || order.GeneralInfo==null || order.GeneralInfo.Source==null || order.GeneralInfo.SubSource==null || typeof order.GeneralInfo.Source!=="string" || typeof order.GeneralInfo.SubSource!=="string") {
              console.log(`INVALID ORDER DATA`);
              continue;
            }
            if(checkItemSkus(order.Items)===false) continue;
            const source= order.GeneralInfo.Source.trim().toLowerCase();
            const subSource= order.GeneralInfo.SubSource.trim().toLowerCase();
            let shippingServiceId="";
            if(subSource.includes("northern")) shippingServiceId= processNorthernOrder(order, shopify_map, postCodePrefixes);
            else if(source.includes("amazon")) shippingServiceId= processAmazonOrder(order, postCodePrefixes);
            else shippingServiceId=processOtherOrders(order, postCodePrefixes);
            if(shippingServiceId==null) {
              printErrors.push({
                msg: `FAILED TO FETCH ORDER: ${order.NumOrderId} POSTALSERVICE ID`
              });
              continue;
            }
            try{
              await changeShippingMethod(order, token, shippingServiceId);
            }catch(err) {
              const errorMsg = (err instanceof Error)
                            ? `ERROR: ${err.message}\nSTACK: ${err.stack}`
                            : `ERROR: ${JSON.stringify(err, null, 2)}`;
              printErrors.push({
                msg: `FAILED TO UPDATE SHIPPING SERVICE FOR ORDER: ${order.NumOrderId}`,
                reason: errorMsg
              });
              continue;
            }
            const data=`${order.OrderId}|${order.NumOrderId}`;
            if(source.includes("amazon")) amazonSportsOrders.push(data);
            else if(subSource.includes("northern")) {
              const refNum= order.GeneralInfo.ReferenceNum.trim();
              const isExpress=shopify_map[refNum].includes("express");
              if(isExpress) {
                console.log(`norhtern express order: ${order.NumOrderId}`);
                northernExpressSportsOrders.push(data);
              }
              else northernSportsOrders.push(data);
            }
            else if(source.includes("temu")) temuSportsOrders.push(data);
            else otherSportsOrders.push(data);
        }
        console.log(`finished fetching orders`);
    }catch(err) {
        console.log(`SPORTS ORDERS PROCESSING FAILED!`);
        const errorMsg = (err instanceof Error)
                    ? `ERROR: ${err.message}\nSTACK: ${err.stack}`
                    : `ERROR: ${JSON.stringify(err, null, 2)}`;
        console.log(errorMsg);
    }
}

function processNorthernOrder(order, shopify_map, postCodePrefixes) {
  const refNum= order.GeneralInfo.ReferenceNum.trim();
  if(shopify_map.hasOwnProperty(refNum)===false) {
      console.log(`order:${order.NumOrderId}, refNum: ${order.GeneralInfo.ReferenceNum} not found in shopify db`);
      return null;
  }
  if(shopify_map[refNum].includes("pallet")) return null;
  const isExpress= shopify_map[refNum].includes("express");
  const totalWeight= order.ShippingInfo.TotalWeight;
  const postCode= order.CustomerInfo.Address.PostCode.trim().toLowerCase();
  const isOutOfArea= postCodePrefixes.some(pc=> postCode.startsWith(pc));
  const isBTPostCode= postCode.startsWith("bt");
  if(isBTPostCode) return DPD_TWO_DAY;
  if(totalWeight<=15) {
    if(isExpress) return M28_24;
    else return M28_48;
  }else {
    if(isOutOfArea) return DPD_TWO_DAY;
    else return DPD_NEXT_DAY;
  }
}

function processAmazonOrder(order, postCodePrefixes) {
  const identifiers = order.GeneralInfo?.Identifiers;  
  if(identifiers==null) return null;
  let isPrime=false;
  for(let k=0; k<identifiers.length; k++) {
      const idf=identifiers[k];
      if((idf.IdentifierId && idf.IdentifierId===2) || (idf.Tag && typeof idf.Tag==="string" && idf.Tag.trim().toLowerCase().includes('amazon_prime')) || (idf.Name && typeof idf.Name==="string" && idf.Name.trim().toLowerCase().includes('amazon prime'))) {
          isPrime=true;
          break;
      }
  }
  const totalWeight= order.ShippingInfo.TotalWeight;
  const postCode= order.CustomerInfo.Address.PostCode.trim().toLowerCase();
  const isOutOfArea=postCodePrefixes.some(pc=> postCode.startsWith(pc));
  if(isPrime) {
    if(isOutOfArea || totalWeight>15) return ABS_DPD_NEXT_DAY;
    else return ABS_EVRI_LINKED_NEXT_DAY;
  }
  else if(totalWeight>15) return DPD_NEXT_DAY;
  else return M28_48;
}

function processOtherOrders(order, postCodePrefixes) {
  const totalWeight= order.ShippingInfo.TotalWeight;
  const postCode= order.CustomerInfo.Address.PostCode.trim().toLowerCase();
  const isOutOfArea=postCodePrefixes.some(pc=> postCode.startsWith(pc));
  if(totalWeight<=15) return M28_48;
  else if(isOutOfArea) return DPD_TWO_DAY;
  else return DPD_NEXT_DAY;
}

function checkItemSkus(items) {
  const exceptionSkus={
  "!FLOORMAT_20MM": 1,
  "!BENCH_STORAGE": 1,
  "!HALF_RACK": 1,
  "!POWER_RACK": 1,
  "!ADJUSTABLE_DBELL_40KG_2": 1,
  "!HEX_DBELL_32.5KG_2": 1,
  "!HEX_DBELL_35KG_2": 1,
  "!HEX_DBELL_37.5KG_2": 1,
  "!HEX_DBELL_40KG_2": 1,
  "!HEX_DBELL_45KG_2": 1,
  "!HEX_DBELL_50KG_2": 1
  };
  if(items==null || !Array.isArray(items)) return false;
  for(let i=0; i<items.length; i++) {
    const item= items[i];
    const itemId= item.ItemId;
    if(itemId==null || itemId==="00000000-0000-0000-0000-000000000000") return false;
    const itemSku= item.SKU;
    if(itemSku==null) return false;
    if(exceptionSkus.hasOwnProperty(itemSku)) return false;
    if(itemSku.toLowerCase().includes("floormat")) return false;
  }
  return true;
}




async function getShopifyData() {
    const shopify_data= await fetchOrdersPaginated();
    if(shopify_data==null || !Array.isArray(shopify_data)) throw new Error("shopify data invalid");
    const shopify_map={};
    for(let j=0; j<shopify_data.length; j++) {
        let id= shopify_data[j].id;
        if(id && typeof id==="string") {
            id= id.split('/');
            id= id[id.length-1].trim();
            //console.log(id);
        }
        const edges= shopify_data[j].shippingLines?.edges;
        if(edges==null || !Array.isArray(edges)) continue;
        for(let k=0; k<edges.length; k++) {
            const node= edges[k].node;
            if(node==null) continue;
            let ss= node.title || node.code || null;
            if(ss==null) continue;
            ss=ss.trim().toLowerCase();
            if(ss.includes("standard") || ss.includes("express") || ss.includes("pallet") || ss.includes("shipped by seller") || ss.includes("shipping")) {
                shopify_map[id]=ss;
                break;
            }else continue;
        }
    }
    return shopify_map;
}

async function fetchOrdersPaginated() {
  const query = `
    query getOrders($cursor: String) {
      orders(first: 5, after: $cursor, query: "status:open") {
        edges {
          node {
            id
            name
            shippingLines(first: 5) {
              edges {
                node {
                  title
                  code
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  let allOrders = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    try {
      const response = await axios({
        url: SHOPIFY_URL,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ACCESS_TOKEN,
        },
        data: {
          query,
          variables: { cursor },
        },
      });
      const ordersData = response.data.data.orders;
      const edges = ordersData.edges;

      // Push results into our array
      allOrders.push(...edges.map(edge => edge.node));

      // Pagination update
      hasNextPage = ordersData.pageInfo.hasNextPage;
      cursor = ordersData.pageInfo.endCursor;

    } catch (err) {
      console.log(err);
      break;
    }
  }

  return allOrders;
}

async function changeShippingMethod(order, token, PostalServiceId) {
    try{
        const changeShippingMethodWrapper= changeShippingMethodLimiter.wrap(async (order, token, PostalServiceId)=> {
            const res=await axios({
                url: `${BASE_URL}/api/Orders/SetOrderShippingInfo`,
                method: 'POST',
                headers: {
                    Authorization: token
                },
                data: {
                    OrderId: order.OrderId,
                    info: {
                        PostalServiceId,
                    }
                }
            });
            if(res.status!==200) throw new Error("shipping update api error");
            console.log(`successfully update shipping service, for order: ${order.OrderId} , NumOrderId: ${order.NumOrderId}`);
        });
        await changeShippingMethodWrapper(order, token, PostalServiceId);
    }catch(err) {
        console.log(`shippingMethod Update FAILED, order: ${order.OrderId} , NumOrderId: ${order.NumOrderId}`);
        throw err;
    }
}


async function printSportsOrders(token, FolderId, ukTime, orderType, orders) {
    const maxLimit=50;
    let tmp=[];
    try{
        const dataLen=orders.length;
        let i=0;
        while(i<dataLen) {
            if(tmp.length===maxLimit) {
                await clearInvoiceFolder();
                await downloadAndUpload(tmp, token, FolderId, orderType, ukTime);
                tmp=[];
            }
            const spaceLeft=maxLimit-tmp.length;
            const currentLen=dataLen-i;
            if(currentLen<=spaceLeft) {
                tmp.push(...orders.slice(i,i+currentLen));
                i+=currentLen;
            }else {
                tmp.push(...orders.slice(i,i+spaceLeft));
                i+=spaceLeft;
            }
        }
        if(tmp.length>0) {
            await clearInvoiceFolder();
            await downloadAndUpload(tmp, token, FolderId, orderType, ukTime);
            tmp=[];
        }
    }catch(err) {
        throw err;
    }
}

async function clearInvoiceFolder() {
    try{
        const invoiceFiles=await fsp.readdir(invoiceFolderPath);
        for(const file of invoiceFiles) {
            const filePath=`${invoiceFolderPath}/${file}`;
            await fsp.unlink(filePath);
        }
    }catch(err) {
        console.log(`Error clearing invoice folder`);
        throw err;
    }   
}

async function downloadAndUpload(ids, token, FolderId, orderType, ukTime) {
    console.log(`Printing ids:`);
    ids.forEach(id=>console.log(id));
    const orderIds=ids.map(id=>(id.split('|')[0]));
    pdfCount++;
    try{
        const res=await axios({
            url: `${BASE_URL}/api/PrintService/CreatePDFfromJobForceTemplate`,
            method: 'POST',
            headers: {
                Authorization: token
            },
            data: {
                templateType: "Invoice Template", 
                IDs: orderIds
            }
        });
        
        let errorCount=0;
        if(res.data.KeyedError.length>0 || res.data.PrintErrors.length>0) {
            errorCount=res.data.KeyedError.length || res.data.PrintErrors.length;
             for(let i=0;i<res.data.PrintErrors.length; i++) {
                const errorData=res.data.PrintErrors[i];
                if(errorData.includes("insufficient stock")===false) {
                    printErrors.push({
                        PrintError: errorData,
                        time: ukTime
                    });
                }else console.log(JSON.stringify(errorData, null, 2));
            }
            
        }
        const pdfUrl=res.data.URL;
        const downloadFilePath=`${invoiceFolderPath}/${orderType}_${pdfCount}_${ids.length-errorCount}.pdf`;
        await downloadFile(pdfUrl, downloadFilePath);
        const invoiceFiles=await fsp.readdir(invoiceFolderPath);
        const uploadPromises=[];
        for(const file of invoiceFiles) {
            uploadPromises.push(limiter.schedule(async () => {
                const filePath=`${invoiceFolderPath}/${file}`;
                    const requestBody = {
                        name: `${file}`,
                        parents: [`${FolderId}`]
                    };
                    const media = {
                        mimeType: 'application/pdf',
                        body: fs.createReadStream(filePath),
                    };
                    const res = await driveApi.files.create({
                        requestBody,
                        media,
                        fields: 'id'
                    });
                    console.log(`Uploaded: ${requestBody.name}, id: ${res.data.id}`);
            }));
        };
        await Promise.all(uploadPromises);
        console.log(`Upload Success`);
    }catch(err) {
        console.log(`Error uploading orders: ${ids} count: ${pdfCount}`); 
        //pdfCount--;
        console.log(err);
        const errorMsg = (err instanceof Error)
        ? `ERROR: ${err.message}\nSTACK: ${err.stack}`
        : `ERROR: ${JSON.stringify(err, null, 2)}`;
        printErrors.push({
            msg: `UK orders upload failed`,
            orders: ids,
            reason: errorMsg,
            time: ukTime
        });              
    }  
}

async function downloadFile(url, filePath) {
    let response;
    try {
        response = await axios({
            url: url,
            method: "GET",
            responseType: "stream"
        });
    } catch (err) {
        console.error('Download request failed:');
        throw err;
    }

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', (err) => {
            console.error('File write failed:');
            reject(err);
        });
        // Handle response stream errors
        response.data.on('error', (err) => {
            console.error('Download stream failed:');
            writer.destroy();
            reject(err);
        });
    });
};

function getBatchTime(date) {
    const day=date.split(',')[0].trim().toLowerCase();
    const getHours=Number(date.split(',')[2].trim().split(':')[0])
    const getMinutes=Number(date.split(',')[2].trim().split(':')[1])
    const current_seconds=getHours*60*60 + getMinutes*60;
    let batch_timings;
    let arr;
    if(day==="sunday") {
        batch_timings=["8:00"];
        arr=["08.00 AM"];
    }else {
        batch_timings=["7:00", "10:00", "12:00", "14:30", "15:45"];
        arr=["07.00 AM", "10.00 AM", "12.00 PM", "02.30 PM", "03.45 PM"];
    }
    let ind=0;
    let mini=1e6;
    for(let i=0;i<batch_timings.length;i++) {
        const batch_timing_arr=batch_timings[i].split(':')
        const batch_seconds=Number(batch_timing_arr[0])*60*60  + Number(batch_timing_arr[1])*60;
        const diff=batch_seconds-current_seconds;
        if(mini>diff && diff>0) {
            mini=diff
            ind=i;
        }   
    }
    const dateOnly=date.split(',')[1].split('/').map((part, index) => index === 2 ? part.slice(-2) : part).join('.').trim();
    const batchTime=`${dateOnly} ${arr[ind]}`;
    return batchTime;
}

async function createFolder(folderName, parentFolderId) {
    try{
        const res = await driveApi.files.list({
            fields: 'files(id, name)',
            q: `'${parentFolderId}' in  parents and name= '${folderName}'`,
            spaces: 'drive'
        });
        if(res.data.files.length===0) {
            console.log(`folder ${folderName} not found, creating it...`)
            const fileMetadata = {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [`${parentFolderId}`]
            };
            const file = await driveApi.files.create({
                requestBody: fileMetadata,
                fields: 'id',
            });
            console.log('Folder created, Id:', file.data.id);
            return file.data.id;
        }else return res.data.files[0].id;
    }catch(err) {
        throw err;
    }
}

export async function handler(event) {
  console.time('timer');
  northernSportsOrders=[];
  northernExpressSportsOrders=[];
  amazonSportsOrders=[];
  temuSportsOrders=[];
  otherSportsOrders=[];
  pdfCount=0;
  printErrors=[];
  const date=new Date();
  const ukTime = date.toLocaleString('en-GB', {
      timeZone: 'Europe/London',
      weekday: 'long',   
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
  });
  console.log('ukTime: ', ukTime);
  try{
    checkEnvVar();
    await fsp.mkdir(invoiceFolderPath, {recursive: true});
    client2=new JWT({
        email: client_email2,
        key: formatted_key2,
        scopes: [
            "https://www.googleapis.com/auth/drive.file",
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/drive.readonly"
        ],
    });
    driveApi= drive({ version: "v3", auth: client2 });
    const dateFolderName=ukTime.split(',')[1].split('/').map((part, index) => index === 2 ? part.slice(-2) : part).join('.').trim();
    const dateFolderId=await createFolder(dateFolderName, root_folder_id)
    const dateTimeFolderName=getBatchTime(ukTime);
    const dateTimeFolderId=await createFolder(dateTimeFolderName, dateFolderId);
    const sportsFolderName='Sports';
    const sportsFolderId=await createFolder(sportsFolderName, dateTimeFolderId);
    const auth=await authorize();
    await processOpenOrders(auth.Token, ukTime);
    await printSportsOrders(auth.Token, sportsFolderId, ukTime, "northern", northernSportsOrders);
    pdfCount=0;
    await printSportsOrders(auth.Token, sportsFolderId, ukTime, "northern_express", northernExpressSportsOrders);
    pdfCount=0;
    await printSportsOrders(auth.Token, sportsFolderId, ukTime, "amazon", amazonSportsOrders);
    pdfCount=0;
    await printSportsOrders(auth.Token, sportsFolderId, ukTime, "temu", temuSportsOrders);
    pdfCount=0;
    await printSportsOrders(auth.Token, sportsFolderId, ukTime, "other", otherSportsOrders);
    console.log("All files uploaded successfully.");
    console.timeEnd('timer');
    if(printErrors.length>0) {
        console.log("PRINT ERRORS: ");
        console.log(JSON.stringify(printErrors, null, 2));
        try{
            await sns.publish({
                TopicArn: SNS_TOPIC_ARN,
                Subject: 'SPORTS PRINT ERROR',
                Message: JSON.stringify(printErrors, null, 2)
            }).promise();
        }catch(err) {
            console.log("SNS MESSAGE FAILED");
            console.log(err);
        }
    }
  }catch(err) {
    console.log(err);
        const errorMsg = (err instanceof Error)
        ? `ERROR: ${err.message}\nSTACK: ${err.stack}`
        : `ERROR: ${JSON.stringify(err, null, 2)}`;
  }
}

function checkEnvVar() {
    const requiredEnvVars = [
        'CLIENT_EMAIL',
        'PRIVATE_KEY',
        'ROOT_FOLDER_ID4',
        'LINNWORKS_APP_ID',
        'LINNWORKS_APP_SECRET',
        'LINNWORKS_API_TOKEN',
        'LINNWORKS_BASE_URL',
        'DPD_NEXT_DAY',
        'DPD_TWO_DAY',
        'ABS_DPD_NEXT_DAY',
        'ABS_EVRI_LINKED_NEXT_DAY',
        'EVRI_M28_48',
        'EVRI_M28_24',
        'UK_COUNTRY_ID',
    ];

    for (const key of requiredEnvVars) {
        if (!process.env[key] || process.env[key].trim() === '') {
            throw new Error(`Missing required environment variable: ${key}`);
        }
    }
}



