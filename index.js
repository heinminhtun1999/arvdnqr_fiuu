const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const dotenv = require("dotenv");
const path = require("path");
const { createServer } = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const cors = require("cors");
const qs = require("qs");
const { ref } = require("process");
const { machine } = require("os");

dotenv.config();

/*
================================
Initialization and Configuration
================================
*/

const PORT = process.env.PORT || 4000;
let isTesting = false;
let URLS = {
    true: {
        arvdnqr: "https://argo.arvending.com.my/beta/arvdnqrapi",
        eShop2Online: "https://argo.arvending.com.my/beta/eshop2/online",
        eShop2QR: "https://argo.arvending.com.my/beta/eshop2/offline",
        eshop2ARgo: "https://betapi.arvending.com.my/eshop2"
    },
    false: {
        arvdnqr: "https://argo.arvending.com.my/arvdnqrapi",
        eShop2Online: "https://argo.arvending.com.my/eshop2/online",
        eShop2QR: "https://argo.arvending.com.my/eshop2/offline",
        eshop2ARgo: "https://app.arvending.com.my/eshop2"
    }

};

const app = express();

const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: "*" })); // Enable CORS for all origins
app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "public")));

// --- Socket.io connection handler ---
io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    socket.on("joinOrderRoom", (referenceId) => {
        socket.join(`order_${referenceId}`);
        console.log(`Socket ${socket.id} joined room order_${referenceId}`);
    });

    socket.on("readyToDeliver", (referenceId) => {
        console.log(`Starting delivery for order: ${referenceId}`);
        deliverProducts(referenceId);
    });

    socket.on("disconnect", () => {
        console.log("Client disconnected:", socket.id);
    });
});

/*
===========
Orders Json
===========
*/
const orderJsonFilePath = path.join(__dirname, "/public/orders.json");

if (!fs.existsSync(orderJsonFilePath)) {
    fs.writeFileSync(orderJsonFilePath, JSON.stringify([]));
}

// (async () => {
//     const data = fs.readFileSync(orderJsonFilePath);
//     const orders = JSON.parse(data);
//     console.log("Initial data:", orders);
//     // fs.unlinkSync(orderJsonFilePath);
// })()

app.get("/testing", (req, res) => {
    isTesting = true;
    res.render("index");
});

app.get("/", (req, res) => {
    isTesting = false;
    res.render("index");
})

/*
=================
Offline Checkout Endpoint
=================
*/
app.post("/offline", async (req, res) => {
    const { cartData, no_dstatus, stoppoint, delivery } = req.body;
    const data = JSON.parse(cartData);
    const totalQuantity = data.cartItems.reduce((sum, item) => sum + item.quantity, 0);;

    let url = URLS[isTesting][data.payment_method] + "/precreate/"; // ARgo URL

    const referenceId = createOrderID(data.machine_id);

    // Create request body for ARgo QR
    const body = {
        version: "v3",
        channelId: "24",
        storeId: "ARarvgo01",
        referenceId: referenceId,
        currencyCode: "MYR",
        amount: data.total.toFixed(2),
        hashType: "hmac-sha256",
        terminalId: "1119210argo",
        validityDuration: "180"
    }

    // Create order object and add to activeOrders
    const order = {
        referenceId: referenceId,
        amount: data.total.toFixed(2),
        items: data.cartItems.map(item => ({ ...item, deliveryStatus: [] })),
        timestamp: Date.now(),
        active: true,
        paymentCompleted: false,
        totalQuantity: totalQuantity,
        isDelivering: false,
        platform: data.payment_method, // Indicate platform
        machineId: data.machine_id,
        no_dstatus: no_dstatus === "on" ? true : false,
        stoppoint: stoppoint ? parseInt(stoppoint) : 0,
        isTesting: isTesting,
        delivery: delivery || "random"
    }

    // Saving order to orders.json
    addOrderToJson(order);

    // Create signature for request body for ARgo QR
    const hash = generateHash(body, getKey(data.machine_id));
    body["signature"] = hash;
    console.log("Request Body:", body);
    try {
        const start = (new Date()).getTime()
        const response = await axios.post(url, qs.stringify(body), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        const end = (new Date()).getTime()

        console.log((end - start) / 1000, "seconds")

        const data = response.data;
        console.log("Response Data:", data);

        if (!validateSignature(data.response, order.machineId)) {
            console.log("Invalid signature for precreate:", referenceId);
            return res.status(400).json({
                success: false,
                message: "(40103) Invalid signature from ARgo"
            });
        }

        if (data.success && data.response.statusCode === "00") {

            // Start timeout check (3 minutes)
            checkTimeout(180, referenceId);
            return res.render("payment", { data: data.response });
        } else {
            return res.send("Error creating order");
        }

    } catch (e) {
        console.log("ERROR", e.response ? e.response.data : e.message);
        return res.status(500).json(e.response ? e.response.data : { message: e.message });
    }
});

/*
============
Cancel Order
============
*/
app.post("/cancel", async (req, res) => {
    const { orderData } = req.body;
    const order = JSON.parse(orderData);

    const existingOrder = getOrderFromJson(order.referenceId);

    if (existingOrder.paymentCompleted) {
        console.log("Order already paid, cannot cancel:", order.referenceId);
        return res.send("Order already paid, cannot cancel.");
    }

    const referenceId = order.referenceId;
    const url = URLS[isTesting][existingOrder.platform] + "/reversal/";

    console.log("URL: ", url);
    const body = {
        version: "v3",
        referenceId: referenceId,
        paymentReferenceId: referenceId,
        hashType: "hmac-sha256",
    }

    const hash = generateHash(body, getKey(existingOrder.machineId));
    body["signature"] = hash;

    console.log("Cancel Request Body:", body);

    try {

        const response = await axios.post(url, qs.stringify(body), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        })

        const data = response.data;
        console.log("Cancel Response Data:", data);
        if (!validateSignature(data.response, existingOrder.machineId)) {
            console.log("Invalid signature for cancel response:", referenceId);
            return res.status(400).json({
                success: false,
                message: "(40103) Invalid signature"
            });
        }

        if (data.success && data.response.statusCode === "00") {
            // Update order to inactive
            updateOrderInJson(referenceId, "active", false); //need to implement retry mechanism here
            console.log("Order cancelled successfully:", referenceId);
        } else {
            console.log("Failed to cancel order:", referenceId);
        }

    } catch (e) {
        console.log("ERROR", e);
        return res.status(500).json(e);
    }

    return res.redirect("/");
});

/*
=====================
Notification Endpoint
=====================
*/
app.post("/offline/notification", (req, res) => {

    const order = getOrderFromJson(req.body.referenceId);

    if (!order) {
        console.log("Order not found for notification:", req.body.referenceId);
        return res.status(404).json({
            success: false,
            message: "(1004) Reference ID does not exist."
        });
    }

    if (!validateSignature(req.body, order.machineId)) {
        console.log("Invalid signature for notification:", req.body.referenceId);
        return res.status(400).json({
            success: false,
            message: "(1001) Invalid signature"
        });
    }

    if (!order.active) {
        console.log("Order is expired", req.body.referenceId);
        return res.status(400).json({
            success: false,
            message: "(1005) Order is expired"
        });
    }

    const data = req.body;

    console.log("Notification Data:", data);

    const referenceId = data.referenceId;
    if (data.statusCode == "99") {
        console.log(`Payment for order ${data.referenceId} failed.`);
        updateOrderInJson(referenceId, "paymentCompleted", false);
        updateOrderInJson(referenceId, "active", false);
        io.to(`order_${referenceId}`).emit("paymentStatus", {
            status: false,
            message: "Payment failed",
            referenceId
        });
    } else if (data.statusCode == "00") {
        console.log(`Payment for order ${data.referenceId} successful.`);
        updateOrderInJson(referenceId, "paymentCompleted", true);
        io.to(`order_${referenceId}`).emit("paymentStatus", { // emit notification to client to redirect the user to delivery page
            status: true,
            message: "Payment successful",
            referenceId
        });
    }

    return res.send({ success: true, message: "RECEIVEDOK" });
});

/*
===============
Status Page
===============
*/
app.get("/status", (req, res) => {
    const referenceId = req.query.referenceId;
    const order = getOrderFromJson(referenceId);
    console.log("Status Page Reference ID:", referenceId);
    const { success, message } = req.query;
    console.log("Status Query:", req.query);

    if (success === "false") {
        return res.render("status", { order: {}, success: success === false, message, isTesting: order.isTesting });
    }

    return res.render("status", { order, success: true, message: "Payment successful", isTesting: order.isTesting });
});

/*
=================
Online Checkout Endpoint
=================
*/
app.get("/online", async (req, res) => {
    const { cartData, no_dstatus, stoppoint, delivery } = req.query;

    const data = JSON.parse(cartData);
    const totalQuantity = data.cartItems.reduce((sum, item) => sum + item.quantity, 0);

    const currentURL = req.protocol + '://' + req.get('host') + "/online";
    const returnURL = currentURL + "/return";
    const callbackURL = currentURL + "/notification";
    const cancelURL = currentURL + "/cancel";

    let url = URLS[isTesting]["eShop2Online"] + "/payment/"; // ARgo URL

    const referenceId = createOrderID(data.machine_id);

    // Create request body for ARgo QR
    const body = {
        amount: data.total.toFixed(2),
        referenceId: referenceId,
        bill_name: "Clarie James",
        bill_email: "clariesjames@example.com",
        bill_mobile: "0123456789",
        bill_desc: JSON.stringify(data.cartItems),
        currency: "MYR",
        returnurl: returnURL,
        callbackurl: callbackURL,
        cancelurl: cancelURL,
        PaymentExpirationTime: new Date(Date.now() + 3 * 60 * 1000).toISOString(), // 3 minutes from now
        waittime: "180",
        metadata: JSON.stringify({ machine_id: data.machine_id })
    }

    // Create order object and add to activeOrders
    const order = {
        referenceId: referenceId,
        amount: data.total.toFixed(2),
        items: data.cartItems.map(item => ({ ...item, deliveryStatus: [] })),
        timestamp: Date.now(),
        active: true,
        paymentCompleted: false,
        totalQuantity: totalQuantity,
        isDelivering: false,
        platform: "eShop2Online", // Indicate online platform
        machineId: data.machine_id,
        no_dstatus: no_dstatus === "on" ? true : false,
        isTesting: isTesting,
        stoppoint: stoppoint ? parseInt(stoppoint) : 0,
        delivery: delivery || "random"
    }

    // Saving order to orders.json
    addOrderToJson(order);

    // Create signature for request body for ARgo QR
    const key = getKey(data.machine_id);
    const hash = generateHash(body, key);
    body["signature"] = hash;
    console.log("Payment Request Body:", body);
    const queryString = qs.stringify(body);
    let paymentURL = url + "?" + queryString;

    console.log("Payment URL:", paymentURL);
    checkTimeout(180, referenceId); // Start timeout check (3 minutes)
    return res.redirect(paymentURL);
});


/*
=================
Online Return Endpoint
=================
*/
app.get("/online/return", (req, res) => {


    const order = getOrderFromJson(req.query.referenceId);
    console.log("Online Return Query:", req.query);
    console.log("Online Return Body:", req.body);
    console.log("Order fetched:", order);

    // Validate signature 
    if (!validateSignature(req.query, order.machineId)) {
        console.log("Invalid signature for notification:", req.query.referenceId);
        return res.redirect("/status?success=false&message=Invalid%20signature");
    }

    if (!order) {
        console.log("Order not found for notification:", req.query.referenceId);
        return res.redirect("/status?success=false&message=Order%20not%20found");
    }

    if (!order.active) {
        console.log("Order is expired", req.query.referenceId);
        return res.redirect("/status?success=false&message=Order%20is%20expired");
    }

    const data = req.query;
    const referenceId = data.referenceId;

    if (data.status == "00") {
        updateOrderInJson(referenceId, "paymentCompleted", true);
        console.log(`Payment for order ${data.referenceId} successful.`);
        return res.redirect("/status?referenceId=" + referenceId + "&success=true");
    } else if (data.status == "11") {
        updateOrderInJson(referenceId, "paymentCompleted", false);
        updateOrderInJson(referenceId, "active", false);
        return res.redirect("/status?success=false&message=Payment%20failed&referenceId=" + referenceId);
    } else {
        return res.redirect("/status?success=false&message=Payment%20pending&referenceId=" + referenceId);
    }
});


/*
=================
Online Notification Endpoint
=================
*/
app.post("/online/notification", (req, res) => {

    const order = getOrderFromJson(req.body.referenceId);
    console.log("Online Notification Body:", req.body);

    if (!order) {
        console.log("Order not found for notification:", req.body.referenceId);
        return res.status(404).json({
            success: false,
            message: "(1004) Reference ID does not exist"
        });
    }

    // Validate signature 
    if (!validateSignature(req.body, order.machineId)) {
        console.log("Invalid signature for notification:", req.body.referenceId);
        return res.status(400).json({
            success: false,
            message: "(1001) Invalid signature"
        });
    }

    if (!order.active) {
        console.log("Order is expired", req.body.referenceId);
        return res.status(400).json({
            success: false,
            message: "(1005) Order is expired"
        });
    }

    if (!order.isDelivering && req.body.status == "00") {
        // Start delivery process if not already started
        deliverProducts(req.body.referenceId);
    }

    return res.send({ success: true, message: "RECEIVEDOK" });
});

/*
=================
Online Cancel Endpoint
=================
*/
app.get("/online/cancel", (req, res) => {
    return res.send("Cancel URL - Payment Cancelled. You can close this page.");
});

/*
=================
ARgo Payment Method Endpoint 
=================
*/
app.get("/argo", (req, res) => {
    const { cartData, no_dstatus, stoppoint, delivery } = req.query;

    const data = JSON.parse(cartData);
    const totalQuantity = data.cartItems.reduce((sum, item) => sum + item.quantity, 0);

    const referenceId = createOrderID(data.machine_id);

    let url = URLS[isTesting]["eshop2ARgo"]; // ARgo URL

    // Create order object and add to activeOrders
    const order = {
        referenceId: referenceId,
        amount: data.total.toFixed(2),
        items: data.cartItems.map(item => ({ ...item, deliveryStatus: [] })),
        timestamp: Date.now(),
        active: true,
        paymentCompleted: false,
        totalQuantity: totalQuantity,
        isDelivering: false,
        platform: "eshop2ARgo", // Indicate online platform
        machineId: data.machine_id,
        no_dstatus: no_dstatus === "on" ? true : false,
        isTesting: isTesting,
        stoppoint: stoppoint ? parseInt(stoppoint) : 0,
        delivery: delivery || "random"
    }

    // Saving order to orders.json
    addOrderToJson(order);

    // Body
    const body = {
        referenceid: referenceId,
        mid: data.machine_id,
        amount: data.total.toFixed(2)
    }

    const queryString = qs.stringify(body);
    const paymentURL = url + "?" + queryString;
    
    console.log("Payment URL: ", paymentURL);

    return res.redirect(paymentURL);
});


/*
=================
ARgo Notification Endpoint 
=================
*/
app.post("/argo/notification", (req, res) => {
    const referenceid = req.body.referenceId;

    const order = getOrderFromJson(referenceid);
    // console.log("Notification", order, referenceid)
    console.log("Callback Request Body", req.body)
    if (!order) {
        console.log("Order not found for notification:", req.body.referenceId);
        return res.status(200).json({
            success: false,
            message: "(1004) Reference ID does not exist"
        });
    }

    if (!validateSignature(req.body, order.machineId)) {
        const response = {
            success: false,
            message: "(1001) Invalid signature"
        }
        console.log("Invalid signature for notification:", req.body.referenceId);

        return res.status(200).json(response);
    }


    if (!order.active) {
        console.log("Order is expired", req.body.referenceId);
        return res.status(200).json({
            success: false,
            message: "(1005) Order is expired"
        });
    }

    if (!order.isDelivering && req.body.statusCode == "00") {
        deliverProducts(req.body.referenceId);
    }

    const response = {
        success: true,
        message: "RECEIVEDOK"
    }

    return res.status(200).send(response);
});



/*
=================
iPay88 Payment Gateway Integration
=================
*/

app.get("/ipay88/response", (req, res) => {
    const data = req.query
    res.status(200).json({ message: "iPay88 Response Received", data });
});

app.post("/ipay88/backend", (req, res) => {
    const data = req.body
    console.log("iPay88 Backend Notification:", data);
    res.status(200).json({ message: "iPay88 Notification Received", data });
});

app.get("/version", (req, res) => {
    return res.json({
        version: "argo-callback-test-v2",
        time: new Date()
    });
});


/*
================
Start the Server
================
*/
httpServer.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

/* 
=================
Utility Functions
================= 
*/
function createOrderID(machine_id) {
    let text = machine_id + "-";
    const randomNumber = Math.floor(Math.random() * 1000) + 1000;
    const timestamp = Date.now();
    const randomNumber2 = Math.floor(Math.random() * 999) + 1;
    text += Math.round(timestamp / randomNumber2 * 1.5) + randomNumber;
    return text;
}

function getKey(machineId) {
    if (machineId === "testmachine2") {
        return process.env.arvdnqrkey;
    } else if (machineId === "eshop2test") {
        return process.env.eshop2offlinekey;
    } else if (machineId === "eshop2testjp") {
        return process.env.jpkey;
    }
}

// Generate HMAC SHA256 hash
function generateHash(data, key) {
    // iPay88: Signature = HMAC_SHA512(key, MerchantCode + RefNo + Amount(without ".") + Currency)
    // Do NOT prepend the key into the data string; key goes only into createHmac.

    let dataCopy = { ...data };
    delete dataCopy["signature"];

    dataCopy = Object.keys(dataCopy).sort((a, b) => a.localeCompare(b)).reduce((obj, key) => {
        obj[key] = dataCopy[key];
        return obj;
    }, {});

    let hashString = "";
    for (const key in dataCopy) {
        hashString += dataCopy[key];
    }
    
    return crypto
        .createHmac("sha256", key || "abc")
        .update(hashString, "utf8")
        .digest("hex");
}

// Validate Signature
function validateSignature(data, machineId) {
    const signature = data.signature;
    const expectedHash = generateHash(data, getKey(machineId));
    
    return signature === expectedHash;
}

// Payment Timeout Check
function checkTimeout(duration, referenceId) {

    setTimeout(() => {
        const order = getOrderFromJson(referenceId);
        if (order && !order.paymentCompleted) {
            updateOrderInJson(referenceId, "active", false);
            io.to(`order_${referenceId}`).emit("paymentStatus", {
                status: false,
                message: "Payment expired",
                referenceId
            });
            console.log(`Order ${referenceId} has timed out. Cancelling...`);
        }
    }, duration * 1000);
}

// Adding order to orders.json
function addOrderToJson(order) {
    const ordersData = fs.readFileSync(orderJsonFilePath);

    const orders = JSON.parse(ordersData);
    orders.push(order);
    fs.writeFileSync(orderJsonFilePath, JSON.stringify(orders, null, 2));
}

// Get single order from orders.json
function getOrderFromJson(referenceId) {
    const ordersData = fs.readFileSync(orderJsonFilePath);
    const orders = JSON.parse(ordersData);
    return orders.find(o => o.referenceId === referenceId);
}

// Update single field of order in orders.json by referenceId
function updateOrderInJson(referenceId, updateField, updateValue) {
    const orderData = fs.readFileSync(orderJsonFilePath);
    const orders = JSON.parse(orderData);
    const orderIndex = orders.findIndex(o => o.referenceId === referenceId);

    if (orderIndex !== -1) {
        orders[orderIndex][updateField] = updateValue;
        fs.writeFileSync(orderJsonFilePath, JSON.stringify(orders, null, 2));
        return orders[orderIndex];
    } else {
        console.log("Order not found for update:", referenceId);
        return null;
    }
}

async function deliverProducts(referenceId) {

    const order = getOrderFromJson(referenceId);

    if (order.isDelivering || order.no_dstatus) return; // Prevent multiple delivery processes

    updateOrderInJson(referenceId, "isDelivering", true);

    let itemLeft = order.totalQuantity;
    let successCount = 0;
    const jpFailDeliStatus = {
        "referenceId": referenceId,
        "orderId": referenceId,
        "statusCode": "99",
        "itemDesc": "",
        "itemsToDispense": "",
        "amount": 0.00,
    };
    console.log(`Starting delivery for order: ${referenceId}`);
    for (const item of order.items) {

        for (let i = 0; i < item.quantity; i++) {

            if (order.stoppoint > 0 && order.stoppoint == i) break; // Stop delivery at the specified stop point for testing purposes
            const delivery = order.delivery;
            let success;
            // Simulate delivery process
            if (delivery === "random") {
                success = Math.random() <= 0.7; // 70% chance of successful delivery
            } else if (delivery === "success") {
                success = true;
            } else {
                success = false;
            }

            if (success) {
                successCount += 1;
            }

            // const success = true; // For testing purposes, assume all deliveries are successful
            // successCount += 1;

            itemLeft -= 1; // Decrease the count of items left to deliver

            // For DStatus API
            const requestItemDetail = {
                "itemID": item.id,
                "itemName": item.name,
                "alisName": item.name,
                "alisNumber": item.id
            }

            try {

                const machine_id = order.machineId;
                const orderId = createOrderID(machine_id) + "-" + item.id;

                // For orders.json
                const deliveryStatus = {
                    orderId: orderId,
                    deliverySuccess: success,
                    timestamp: Date.now()
                }

                // Check if the machine is not JingPin, if not send Dstatus request for each item
                if (machine_id !== "eshop2testjp") {

                    const requestBody = {
                        "referenceId": referenceId,
                        "orderId": orderId,
                        "statusCode": success ? "00" : "99",
                        "itemDesc": JSON.stringify(requestItemDetail),
                        "itemsToDispense": itemLeft.toString(),
                        "amount": item.price.toFixed(2)
                    }

                    if (order.platform === "arvdnqr" || order.platform === "eShop2QR") {
                        requestBody["hashType"] = "hmac-sha256";
                    }

                    const hash = generateHash(requestBody, getKey(order.machineId));
                    requestBody["signature"] = hash;
                    
                    let url;
                    if (order.platform == 'eshop2ARgo') {
                        url = "https://argo.arvending.com.my/eshop2/app/dstatus/";
                    } else {
                        url = URLS[order.isTesting][order.platform] + "/dstatus/";
                    }

                    console.log("Dstatus Request Body: ", requestBody);

                    const response = await axios.post(url, qs.stringify(requestBody), {
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded'
                        }
                    });
                    const data = response.data;

                    if (!success && data.data) {

                        // Validate signature
                        if (!validateSignature(data.data, order.machineId)) {
                            console.log("Invalid signature in refund response for order:", referenceId);
                            continue; // Skip processing this response
                        }

                        if (data.statusCode === "00" || data.Status === "22") {
                            deliveryStatus.refunded = true;
                        } else if (data.statusCode === "99" || data.Status === "11") {
                            deliveryStatus.refunded = false;
                        }
                    }

                    // Log response for debugging
                    console.log(`Item ${order.totalQuantity - itemLeft} \ndelivery response:`, data, "\n========================");
                } else {
                    if (!success) {
                        jpFailDeliStatus.amount += item.price;
                    }
                }

                // Update refund status in orders.json
                item.deliveryStatus.push(deliveryStatus);
                updateOrderInJson(referenceId, "items", order.items);

                // Emit delivery status via Socket.io
                io.to(`order_${referenceId}`).emit("deliveryStatus", {
                    total: order.totalQuantity,
                    itemDelivered: order.totalQuantity - itemLeft,
                    deliverySuccess: success,
                    successCount: successCount,
                    isRefunded: deliveryStatus.refunded,
                    isTesting: order.isTesting
                });

            } catch (e) {
                console.log("ERROR on refund request", e.response ? e.response.data : e.message);
            }

            const timeoutDuration = Math.floor(Math.random() * 10) + 5; // Random delay between 5 to 15 seconds
            await new Promise(resolve => setTimeout(resolve, timeoutDuration * 1000));
        }

    }

    if (order.machineId === "eshop2testjp" && jpFailDeliStatus.amount > 0) {
        try {
            const url = URLS[order.platform] + "/dstatus/";
            const hash = generateHash(jpFailDeliStatus, getKey(order.machineId));
            jpFailDeliStatus["signature"] = hash;
            console.log("JP Refund Request Body: ", jpFailDeliStatus);
            const response = await axios.post(url, qs.stringify(jpFailDeliStatus), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
            const data = response.data;
            console.log("JP Refund Response Data:", data);

            if (data.data) {
                // Validate signature
                if (!validateSignature(data.data, order.platform)) {
                    console.log("Invalid signature in JP refund response for order:", referenceId);
                    return;
                }
            }

        } catch (e) {
            console.log("ERROR on JP refund request", e.response ? e.response.data : e.message);
        }

        updateOrderInJson(referenceId, "isDelivering", false);
        updateOrderInJson(referenceId, "active", false);
    }
}