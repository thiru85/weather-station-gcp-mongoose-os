const functions = require('firebase-functions');
const admin = require('firebase-admin');
const bigquery = require('@google-cloud/bigquery')();
const cors = require('cors')({ origin: true });

admin.initializeApp(functions.config().firebase);

const db = admin.database();

/**
 * Receive data from pubsub, then 
 * Write telemetry raw data to bigquery
 * Maintain last data on firebase realtime database
 */
exports.receiveTelemetry = functions.pubsub
  .topic('telemetry-topic')
  .onPublish(event => {
    const attributes = event.data.attributes;
    const message = event.data.json;

    const deviceId = attributes['deviceId'];

    const data = {
      humidity: message.humidity,
      temp: message.temp,
      deviceId: deviceId,
      timestamp: event.timestamp,
      uptime: message.uptime,
      free_ram: message.free_ram,
      total_ram: message.total_ram
    };

    if (
      message.humidity < 0 ||
      message.humidity > 100 ||
      message.temp > 100 ||
      message.temp < -50
    ) {
      // Validate and do nothing
      return;
    }

    return Promise.all([
      insertIntoBigquery(data),
      updateCurrentDataFirebase(data)
    ]);
  });

/** 
 * Maintain last status in firebase
*/
function updateCurrentDataFirebase(data) {
  return db.ref(`/devices/${data.deviceId}`).set({
    humidity: data.humidity,
    temp: data.temp,
    lastTimestamp: data.timestamp,
    total_ram: data.total_ram
  });
}

/**
 * Store all the raw data in bigquery
 */
function insertIntoBigquery(data) {
  // TODO: Make sure you set the `bigquery.datasetname` Google Cloud environment variable.
  const dataset = bigquery.dataset(functions.config().bigquery.datasetname);
  // TODO: Make sure you set the `bigquery.tablename` Google Cloud environment variable.
  const table = dataset.table(functions.config().bigquery.tablename);

  return table.insert(data);
}

/**
 * Query bigquery with the last 7 days of data
 * HTTPS endpoint to be used by the webapp
 */
exports.getReportData = functions.https.onRequest((req, res) => {
  const table = '`gcpdemoproject:iotdemo.iotweatherdemo`';

  const query = `
    SELECT 
      TIMESTAMP_TRUNC(data.timestamp, HOUR, 'America/Cuiaba') data_hora,
      avg(data.temp) as avg_temp,
      avg(data.humidity) as avg_hum,
      min(data.temp) as min_temp,
      max(data.temp) as max_temp,
      min(data.humidity) as min_hum,
      max(data.humidity) as max_hum,
      count(*) as data_points      
    FROM ${table} data
    WHERE data.timestamp between timestamp_sub(current_timestamp, INTERVAL 7 DAY) and current_timestamp()
    group by data_hora
    order by data_hora
  `;

  return bigquery
    .query({
      query: query,
      useLegacySql: false
    })
    .then(result => {
      const rows = result[0];

      cors(req, res, () => {
        res.json(rows);
      });
    });
});
