const h = require('./Helpers/helpers');
const sleep = h.sleep;
const log = h.log;
const CONFIG = h.CONFIG;
var DEBUG = CONFIG.debug;

const cluster = require('cluster');
const totalCPUs = require('os').cpus().length;

const { setupMaster, setupWorker } = require("@socket.io/sticky");
const { createAdapter, setupPrimary } = require("@socket.io/cluster-adapter");

//////////////////////////////////////////////////////////////////////////////////////////// CORE DATA
var rowData = undefined;
var rowDataObjects = undefined;
var hexPrice = '';
var currentDayGlobal = undefined;
var liveData = undefined;
var currencyRates = undefined;
var hexSiteData = undefined;
var ethereumData = undefined;

//////////////////////////////////////////////////////////////////////////////////////////// MASTER - CREATE WORKERS
if (cluster.isMaster) {
  console.log(`Master ${process.pid} is running - Number of CPUs is ${totalCPUs}`);

  for (let i = 0; i < totalCPUs; i++) {
    var worker = cluster.fork();
    worker.on('message', function(msg) {
      if (msg.grabData) {
        log('Worker to Master: grabData!!!');
        grabData();
      }
      if (msg.kill){
        var workers = JSON.parse(JSON.stringify(cluster.workers));
        log("Worker to Master: kill all workers!");
        for (const id in workers) { cluster.workers[id].kill(); }
      }
    });
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died, creating another`);
    var worker = cluster.fork();
    worker.on('message', function(msg) {
      if (msg.grabData) {
        log('Worker to Master: grabData!!!');
        grabData();
      }
      if (msg.kill){
        var workers = JSON.parse(JSON.stringify(cluster.workers));
        log("Worker to Master: kill all workers!");
        for (const id in workers) { cluster.workers[id].kill(); }
      }
    });
    worker.send({ 
      liveData:         liveData,
      ethereumData:     ethereumData,
      hexSiteData:      hexSiteData,
      hexPrice:         hexPrice,
      currencyRates:    currencyRates,
      rowData:          rowData,
      rowDataObjects:   rowDataObjects,
      currentDayGlobal: currentDayGlobal,
    })
  });

  //////////////////////////////////////////////////////////////////////////////////////////////// TESTING TESTING TESTING

  const http = require('http');
  require('es6-promise').polyfill();

  const express = require('express');
  const path = require('path');
  const fs = require('fs');
  const https = require('https');
  var cors = require('cors');

  const { JSDOM } = require( "jsdom" );
  const { window } = new JSDOM( "" );
  const $ = require( "jquery" )( window );

  var hostname = CONFIG.hostname;
  if (DEBUG){ hostname = '127.0.0.1'; }

  var httpPort = 80;
  if (DEBUG){ httpPort = 3000; }
  const httpsPort = 443;

  var httpsOptions = undefined;
  if(!DEBUG){ httpsOptions = {
    cert: fs.readFileSync(CONFIG.https.cert),
    ca: fs.readFileSync(CONFIG.https.ca),
    key: fs.readFileSync(CONFIG.https.key)
  };}

  const app = express();

  const httpServer = http.createServer(app);
  var httpsServer = undefined;
  if(!DEBUG){ httpsServer = https.createServer(httpsOptions, app);}

  if(!DEBUG){ app.use((req, res, next) => {if(req.protocol === 'http') { res.redirect(301, 'https://' + hostname); } next(); }); }

  app.use(express.static(path.join(__dirname, 'public')));

  app.get("/", function(req, res){ res.sendFile('/index.html', {root: __dirname}); });

  httpServer.listen(httpPort, hostname, () => { log(`Server running at http://${hostname}:${httpPort}/`);});

  if(!DEBUG){ httpsServer.listen(httpsPort, hostname, () => {
      log('listening on *:' + httpsPort);
    });
  }

  if(DEBUG) {
    // setup sticky sessions
    setupMaster(httpServer, {
      loadBalancingMethod: "least-connection",
    });
  } else {
    setupMaster(httpsServer, {
      loadBalancingMethod: "least-connection",
    });
  }

  // setup connections between the workers
  setupPrimary();

  // needed for packets containing buffers
  cluster.setupPrimary({
    serialization: "advanced",
  });

  const MongoDb = require('./Services/MongoDB');
  const TheGraph = require('./Services/TheGraph');
  const Coingecko = require('./Services/Coingecko');
  const Etherscan = require('./Services/Etherscan');
  const DailyStatHandler = require('./Handlers/DailyStatHandler');

  const schedule = require('node-schedule');
  var cron = require('node-cron');

  const fetchRetry = h.fetchRetry;
  const FETCH_SIZE = h.FETCH_SIZE;
  const isEmpty = h.isEmpty;

  var getDataRunning = DailyStatHandler.getDataRunning;
  var DailyStatMaintenance = false;
  var getRowDataRunning = MongoDb.getRowDataRunning;
  var getAndSet_currentGlobalDay_Running = false;
  var getEthereumDataRUNNING = false;
  var getLiveDataRUNNING = false;
  var getCurrencyDataRunning = false;

  var DailyStat = MongoDb.DailyStat;

  //////////////////////////////////////////////////////////////////////////////////////////// GRAB STARTING DATA
  var getRowData = async () => {
    log("getRowData--- AAA");
    returnPackage = await MongoDb.getRowData();

    rowData = returnPackage.rowData;
    rowDataObjects = returnPackage.rowDataObjects;

    hexSiteData = await buildHexSiteData(rowDataObjects);

    //io.emit("rowData", rowData);
    for (const id in cluster.workers) { cluster.workers[id].send({ rowData: rowData, rowDataObjects: rowDataObjects, hexSiteData: hexSiteData}); }
  }

  async function grabData() {
    if (!getLiveDataRUNNING){ await runLiveData(); }
    if (!getCurrencyDataRunning){ getCurrencyData(); };
    if (!getRowDataRunning){ getRowData(); }
    //if (!getDataRunning){ await DailyStatHandler.getDailyData(); }
    if (!getEthereumDataRUNNING){ runEthereumData(); }
  }

  if(!DEBUG) {
      grabData();
  } else {
    if (DEBUG){ log("getRowDataRunning " + getRowDataRunning); if (!getRowDataRunning){ getRowData(); } }
  }

  //////////////////////////////////////////////////////////////////////////////////////////// MASTER - CURRENT DAY
  const ruleCurrentDay = new schedule.RecurrenceRule();
  ruleCurrentDay.hour = 0;
  ruleCurrentDay.minute = 0;
  ruleCurrentDay.second = 30;
  ruleCurrentDay.tz = 'Etc/UTC';

  const jobCurrentDay = schedule.scheduleJob(ruleCurrentDay, function(){
    log('**** DAILY DATA TIMER 30S!');
    if (!getAndSet_currentGlobalDay_Running) { getAndSet_currentGlobalDay(); }
  });

  async function getAndSet_currentGlobalDay(){
    getAndSet_currentGlobalDay_Running = true;
    try {
      var currentDay = await Etherscan.getCurrentDay() + 1;
      log("currentDay: " + currentDay);

      if (currentDayGlobal == undefined || (currentDay != currentDayGlobal && currentDay > currentDayGlobal)) {
        log("currentDay EMIT");
        currentDayGlobal = currentDay;
        //io.emit("currentDay", currentDayGlobal);
        for (const id in cluster.workers) { cluster.workers[id].send({ currentDayGlobal: currentDayGlobal }); }
      }
    } catch (error){
      log("ERROR: " + "getAndSet_currentGlobalDay()");
      console.log(error);
    } finally {
      getAndSet_currentGlobalDay_Running = false;
    }
    await sleep(1000);
  }

  if (!getAndSet_currentGlobalDay_Running && !getDataRunning && !getLiveDataRUNNING) { getAndSet_currentGlobalDay() }


  //////////////////////////////////////////////////////////////////////////////////////////// MASTER - DAILY MAINTENANCE
  cron.schedule('15 * * * * *', async () => {
    log('**** DAILY DATA MAINTENANCE TIMER !');

    if (!getAndSet_currentGlobalDay_Running && !getDataRunning && !getLiveDataRUNNING) { getAndSet_currentGlobalDay() }

    if (!getDataRunning && !DailyStatMaintenance){
      try{
        let latestDay = await TheGraph.get_latestDay();
        let latestDailyData = await DailyStat.find().sort({currentDay:-1});
        let latestDailyDataCurrentDay = latestDailyData[0].currentDay;
        let dailyDataCurrentDayStart = latestDailyData[4].currentDay;

        for (let i = dailyDataCurrentDayStart; i <= latestDailyDataCurrentDay; i++) {
          let ds = await DailyStat.find({currentDay:i});
          for(var key in ds[0]){
            if(key != '$op' && ds[0][key] === null){
              DailyStatMaintenance = true;
              await DailyStatHandler.getDailyData(i);
              if (!getRowDataRunning){ getRowData(); }
              //io.emit("currentDay", currentDayGlobal);
              for (const id in cluster.workers) { cluster.workers[id].send({ currentDay: currentDayGlobal }); }
              break;
            }
          }
        }

        if(latestDay > latestDailyDataCurrentDay) {
          DailyStatMaintenance = true;
          for (let i = latestDailyDataCurrentDay + 1; i <= latestDay; i++) {
            await DailyStatHandler.getDailyData(i);
            if (!getRowDataRunning){ getRowData(); }
            //io.emit("currentDay", currentDayGlobal);
            for (const id in cluster.workers) { cluster.workers[id].send({ currentDay: currentDayGlobal }); }
          }
        }
      }
      catch (err) {
        log('DAILY DATA MAINTENANCE TIMER () ----- ERROR ---' + err.toString() + " - " + err.stack);
      } finally {
        DailyStatMaintenance = false;
      }
    }
  });

  cron.schedule('* * 3 * * *', async () => {
    let latestDay = await TheGraph.get_latestDay();
    for(let i = 1; i <= latestDay; i++){
      let present = await DailyStat.find({currentDay: i}).limit(1);
      if(isEmpty(present)){
        await DailyStatHandler.getDailyData(i);
      }
    }
  });

  //////////////////////////////////////////////////////////////////////////////////////////// MASTER - HEXSITE DATA
  var jobLive15 = schedule.scheduleJob("*/15 * * * *", function() {
    getHexSiteData();
  });

  async function getHexSiteData(){
    if (rowDataObjects) { hexSiteData = await buildHexSiteData(rowDataObjects); }
  }

  async function buildHexSiteData(rowDataObjects){
    if (rowDataObjects) {
      try {
        var highestTshareRateUSD = Math.max.apply(Math, rowDataObjects.map(function(a) { return a.tshareRateUSD; }))

        var prices = rowDataObjects.map(a => a.priceUV2UV3).reverse();

        var pricesBitcoin = await Coingecko.getPriceHistory_Bitcoin(currentDayGlobal); await sleep(500);
        var pricesEthereum = await Coingecko.getPriceHistory_Ethereum(currentDayGlobal); await sleep(500);
        var pricesGold = await Coingecko.getPriceHistory_Gold(currentDayGlobal); await sleep(500);

        var priceHistory = {
          btc: pricesBitcoin,
          eth: pricesEthereum,
          gold: pricesGold
        }

        var priceATH = await Coingecko.getPriceAllTimeHigh(); //await sleep(300);

        var json = {
          averageStakeLength: rowDataObjects[0].averageStakeLength,
          numberOfHolders: rowDataObjects[0].numberOfHolders,
          numberOfHoldersChange: rowDataObjects[0].numberOfHoldersChange,
          currentStakerCount: rowDataObjects[0].currentStakerCount,
          currentStakerCountChange: rowDataObjects[0].currentStakerCountChange,
          totalValueLocked: rowDataObjects[0].totalValueLocked,

          stakedHEX: liveData ? liveData.stakedHEX : rowDataObjects[0].stakedHEX,
          circulatingHEX: liveData ? liveData.circulatingHEX : rowDataObjects[0].circulatingHEX,

          tshareRateUSD_Highest: highestTshareRateUSD,

          priceATH: priceATH,

          priceUV2UV3_Array: prices,
          priceHistory: priceHistory,
        }

        return json;
      } catch (error) {
        log("buildHexSiteData()");
        log(error);
      }
    } else {
      log("buildHexSiteData() - rowDataObjects not ready");
    }
  }

  //////////////////////////////////////////////////////////////////////////////////////////// MASTER - LIVE DATA
  var jobLive = schedule.scheduleJob("*/1 * * * *", function() {
    getAllLiveData();
  });

  async function getAllLiveData(){
    await runLiveData();
    await runEthereumData();
  }

  async function runLiveData() {
    try {
    await sleep(300);
    if (!getDataRunning && !getLiveDataRUNNING){
      var liveDataNew = await getLiveData();
      //console.log(liveDataNew);
      if (liveDataNew && (JSON.stringify(liveDataNew) !== JSON.stringify(liveData))){
        liveData = liveDataNew;
        //io.emit("liveData", liveData);
        for (const id in cluster.workers) { cluster.workers[id].send({ liveData: liveData }); }

        if (liveData.price) {
          hexPrice = liveData.price.toFixed(4);
          //io.emit("hexPrice", hexPrice);
          for (const id in cluster.workers) { cluster.workers[id].send({ hexPrice: hexPrice }); }
        }
      }
    }
    } catch (error){
      log("runLiveData() --- ERROR --- " + error.toString());
    } finally {
      getLiveDataRUNNING = false;
    }
  }

  async function getLiveData() {
    getLiveDataRUNNING = true;
    log("getLiveData()");
    try {
    if (!getDataRunning){
      var priceUV2 = await TheGraph.getUniswapV2HEXDailyPrice(); await sleep(1000);
      //var priceUV3 = await getUniswapV3HEXDailyPrice(); await sleep(1000);

      var { liquidityUV2_HEXUSDC, liquidityUV2_USDC } = await TheGraph.getUniswapV2HEXUSDC_Polling(); await sleep(1000);
      var { liquidityUV2_HEXETH, liquidityUV2_ETH } = await TheGraph.getUniswapV2HEXETH(); await sleep(1000);

      var { liquidityUV3_HEX, liquidityUV3_USDC, liquidityUV3_ETH } = await TheGraph.getUniswapV3(); await sleep(1000);

      var liquidityUV2UV3_HEX = parseInt(liquidityUV2_HEXUSDC + liquidityUV2_HEXETH + liquidityUV3_HEX);
      var liquidityUV2UV3_USDC = parseInt(liquidityUV2_USDC + liquidityUV3_USDC);
      var liquidityUV2UV3_ETH  = parseInt(liquidityUV2_ETH + liquidityUV3_ETH);

      //var priceUV2UV3 = parseFloat(((priceUV2 * (liquidityUV2_USDC / liquidityUV2UV3_USDC)) +
      //(priceUV3 * (liquidityUV3_USDC / liquidityUV2UV3_USDC))).toFixed(8));
      var priceUV2UV3 = priceUV2;

      var tshareRateHEX = await TheGraph.get_shareRateChange(); await sleep(500);
      tshareRateHEX = parseFloat(tshareRateHEX);
      var tshareRateUSD = parseFloat((tshareRateHEX * priceUV2).toFixed(4));

      if (liquidityUV2_HEXUSDC == 0 || liquidityUV2_USDC == 0 || liquidityUV2_HEXETH == 0 || liquidityUV2_ETH == 0) {
        return undefined;
      }

      var { circulatingHEX, stakedHEX, totalTshares, penaltiesHEX } = await Etherscan.getGlobalInfo(); await sleep(500);

      var payout = ((circulatingHEX + stakedHEX) * 10000 / 100448995) + (penaltiesHEX / 2.0);
      var payoutPerTshare = (payout / totalTshares);

      return {
        price: priceUV2UV3,
        tsharePrice: tshareRateUSD,
        tshareRateHEX: tshareRateHEX,
        liquidityHEX: liquidityUV2UV3_HEX,
        liquidityUSDC: liquidityUV2UV3_USDC,
        liquidityETH: liquidityUV2UV3_ETH,
        penaltiesHEX: penaltiesHEX,
        payoutPerTshare: payoutPerTshare,
        stakedHEX: stakedHEX,
        circulatingHEX: circulatingHEX
      };
    }
    } catch (error){
      log("getLiveData() --- ERROR --- " + error.toString());
    } finally {
      getLiveDataRUNNING = false;
    }
  }

  //////////////////////////////////////////////////////////////////////////////////////////// MASTER - ETHEREUM DATA
  async function runEthereumData() {
    try {
    await sleep(300);
    if (!getDataRunning && !getEthereumDataRUNNING){
      var ethereumDataNew = await getEthereumData();
      //console.log(ethereumDataNew);
      if (ethereumDataNew && (JSON.stringify(ethereumDataNew) !== JSON.stringify(ethereumData))){
        ethereumData = ethereumDataNew;
        //io.emit("ethereumData", ethereumData);
        for (const id in cluster.workers) { cluster.workers[id].send({ ethereumData: ethereumData }); }
      }
    }
    } catch (error){
      log("runEthereumData() --- ERROR --- " + error.toString());
    } finally {
      getEthereumDataRUNNING = false;
    }
  }

  async function getEthereumData() {
    getEthereumDataRUNNING = true;
    log("getEthereumData()");
    try {
    if (!getDataRunning){
      var price = await Etherscan.getEthereumPrice(); await sleep(2000);
      var {low, average, high} = await Etherscan.getGas(); await sleep(1000);

      return {
        price: price,
        erc20transfer: (average * 65000 / 1000000000 * price),
        uniswapSwap: (average * 200000 / 1000000000 * price),
        addLiquidity: (average * 175000 / 1000000000 * price),
      };
    }
    } catch (error){
      log("getEthereumData() --- ERROR --- " + error.toString());
    } finally {
      getEthereumDataRUNNING = false;
    }
  }

  //////////////////////////////////////////////////////////////////////////////////////////// MASTER - CURRENCY DATA
  var jobCurrencyRates = schedule.scheduleJob("0 */3 * * *", function() {
    if (!getCurrencyDataRunning) { getCurrencyData(); };
  });

  async function getCurrencyData() {
    log("getCurrencyData() - START");
    getCurrencyDataRunning = true;
    try {
      var rates = await getCurrencyRates();
      if (rates) {
        currencyRates = rates;
        log('SOCKET -- ****EMIT: currencyRates');
        //io.emit("currencyRates", currencyRates);
        for (const id in cluster.workers) { cluster.workers[id].send({ currencyRates: currencyRates }); }
      }
    } catch (error) {
      log("getCurrencyData() - ERROR: " + error);
    } finally {
      getCurrencyDataRunning = false;
    }
  }

  async function getCurrencyRates(){
    var url = "http://api.exchangeratesapi.io/v1/latest?access_key=" + CONFIG.exchangerates.key + "&format=1"; // + "&base=" + base; // Paid Plan
    return await fetchRetry(url, {
      method: 'GET',
      highWaterMark: FETCH_SIZE,
      headers: { 'Content-Type': 'application/json' }
    })
    .then(res => res.json())
    .then(res => {
      if (res && res.success && res.rates) {
        return res.rates;
      }
      return undefined;
    });
  }

} else { ///////////////////////////////////////////////////////////////////////////////////// WORKER - UPDATE DATA
  process.on('message', function(msg) { 
    if (msg.liveData)         { liveData          = msg.liveData;         io.local.emit("liveData",         liveData);          }
    if (msg.ethereumData)     { ethereumData      = msg.ethereumData;     io.local.emit("ethereumData",     ethereumData);      }
    if (msg.hexSiteData)      { hexSiteData       = msg.hexSiteData;                                                            }
    if (msg.hexPrice)         { hexPrice          = msg.hexPrice;         io.local.emit("hexPrice",         hexPrice);          }
    if (msg.currencyRates)    { currencyRates     = msg.currencyRates;    io.local.emit("currencyRates",    currencyRates);     }
    if (msg.rowData)          { rowData           = msg.rowData;          io.local.emit("rowData",          rowData);           }
    if (msg.rowDataObjects)   { rowDataObjects    = msg.rowDataObjects;                                                         }
    if (msg.currentDayGlobal) { currentDayGlobal  = msg.currentDayGlobal; io.local.emit("currentDay",       currentDayGlobal);  }
  }); 
  // https://socket.io/docs/v4/broadcasting-events/#with-multiple-socketio-servers

  //////////////////////////////////////////////////////////////////////////////////////////// WORKER - START SERVER
  const http = require('http');
  require('es6-promise').polyfill();

  const express = require('express');
  const path = require('path');
  const fs = require('fs');
  const https = require('https');
  var cors = require('cors');

  const { JSDOM } = require( "jsdom" );
  const { window } = new JSDOM( "" );
  const $ = require( "jquery" )( window );

  var hostname = CONFIG.hostname;
  if (DEBUG){ hostname = '127.0.0.1'; }

  var httpPort = 80;
  if (DEBUG){ httpPort = 3000; }
  const httpsPort = 443;

  var httpsOptions = undefined;
  if(!DEBUG){ httpsOptions = {
    cert: fs.readFileSync(CONFIG.https.cert),
    ca: fs.readFileSync(CONFIG.https.ca),
    key: fs.readFileSync(CONFIG.https.key)
  };}

  const app = express();

  const httpServer = http.createServer(app);
  var httpsServer = undefined;
  if(!DEBUG){ httpsServer = https.createServer(httpsOptions, app);}

  if(!DEBUG){ app.use((req, res, next) => {if(req.protocol === 'http') { res.redirect(301, 'https://' + hostname); } next(); }); }

  app.use(express.static(path.join(__dirname, 'public')));

  app.get("/", function(req, res){ res.sendFile('/index.html', {root: __dirname}); });

  //httpServer.listen(httpPort, hostname, () => { log(`Server running at http://${hostname}:${httpPort}/`);});

  //if(!DEBUG){ httpsServer.listen(httpsPort, hostname, () => {
  //    log('listening on *:' + httpsPort);
  //  });
  //}

  var io = undefined;
  if(DEBUG){ io = require('socket.io')(httpServer);
  } else { io = require('socket.io')(httpsServer, {secure: true}); }

  // use the cluster adapter
  io.adapter(createAdapter());

  // setup connection with the primary process
  setupWorker(io);

  io.on('connection', (socket) => {
    log('SOCKET -- ************* CONNECTED: ' + socket.id + ' *************');
    //if (!getDataRunning){ DailyStatHandler.getDailyData(); }
    //if (!getRowDataRunning){ getRowData(); }
    if (rowData){           socket.emit("rowData",        rowData); };
    if (hexPrice){          socket.emit("hexPrice",       hexPrice); }
    if (currentDayGlobal){  socket.emit("currentDay",     currentDayGlobal); }
    if (liveData){          socket.emit("liveData",       liveData); }
    if (currencyRates){     socket.emit("currencyRates",  currencyRates); }
    if (ethereumData){      socket.emit("ethereumData",   ethereumData); }
  });

  app.get('/fulldata', cors(), function (req, res) {
    if (rowDataObjects) { res.send(JSON.parse(JSON.stringify(rowDataObjects))); } else {res.status(404).send({ error: "fullData not populated yet" });};
  });

  app.get('/livedata', cors(), function (req, res) {
    if (liveData) { res.send(JSON.parse(JSON.stringify(liveData))); } else {res.status(404).send({ error: "liveData not populated yet" });};
  });

  app.get('/hexsite', cors(), function (req, res) {
    if (hexSiteData) { try { res.send(JSON.parse(JSON.stringify(hexSiteData))); } catch (error) { log("/hexsite"); log(error); } }
    else {res.status(404).send({ error: "hexsite not populated yet" });};
  });

  app.get("/" + CONFIG.urls.grabdata, function (req, res) {
    process.send({ grabData: true });
    res.send(new Date().toISOString() + ' - Grab Data!');
  });

  if (DEBUG){
  app.get("/kill", function (req, res) {
    process.send({ kill: true });
    res.send(new Date().toISOString() + ' - Kill Workers!');
  });
  }
}


/////////////////////////////////////////////////////////////////////////////////// MASTER - GET DATA
//if (cluster.isMaster){
  //let test = async () => {
  //await MongoDb.updateOneColumn(756, "tshareRateHEX", null);
  //var test = await DailyStat.find({currentDay:null});
  //var test2 = test;
  //}; test();
//}
