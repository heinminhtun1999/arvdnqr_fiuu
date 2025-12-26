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
const { platform } = require("os");

dotenv.config();

/*
================================
Initialization and Configuration
================================
*/

const PORT = process.env.PORT || 4000;
const URLS = {
    arvdnqr: "https://argo.arvending.com.my/arvdnqrapi",
    eShop2Online: "https://fonlinedemo.onrender.com",
    // eShop2Online: "https://argo.arvending.com.my/eshop2/online",
    // eShop2Online: "http://localhost:3000",
    eShop2QR: "https://argo.arvending.com.my/eshop2/offline"
}

const app = express();

const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: "*" })); // Enable CORS for all origins
app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.render("index");
});

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


/*
=================
Offline Checkout Endpoint
=================
*/
app.post("/offline", async (req, res) => {
    const { cartData } = req.body;

    const data = JSON.parse(cartData);
    const totalQuantity = data.cartItems.reduce((sum, item) => sum + item.quantity, 0);

    // let url = "https://opa.merchant.razer.com/RMS/API/MOLOPA/precreate.php";
    // let url = "https://api.arvending.com.my/arvdnqrapi/precreate"; // ARgo URL
    let url = URLS[data.payment_method] + "/precreate/"; // ARgo URL
    console.log("Using URL:", url);
    const referenceId = createOrderID(data.machine_id);

    // Create request body for ARgo QR
    const body = {
        // applicationCode: process.env.appcode
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
        platform: data.payment_method // Indicate platform
    }

    // Saving order to orders.json
    addOrderToJson(order);

    // Create signature for request body for ARgo QR
    const hash = generateHash(body, getKey(data.payment_method));
    body["signature"] = hash;
    console.log("Request Body:", body);
    try {
        const response = await axios.post(url, qs.stringify(body), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });


        const data = response.data;
        console.log("Response Data:", data);

        if (!validateSignature(data.response, order.platform)) {
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
    // const url = "https://api.arvending.com.my/arvdnqrapi/reversal";
    const url = URLS[existingOrder.platform] + "/reversal/";

    const body = {
        version: "v3",
        referenceId: referenceId,
        paymentReferenceId: referenceId,
        hashType: "hmac-sha256",
    }

    const hash = generateHash(body, getKey(existingOrder.platform));
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
        if (!validateSignature(data.response, existingOrder.platform)) {
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

        // Need to implement signature validation for response here

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

    // Validate signature - Disabled for testing purposes
    if (!validateSignature(req.body, order.platform)) {
        console.log("Invalid signature for notification:", req.body.referenceId);
        return res.status(400).json({
            success: false,
            message: "(40103) Invalid signature"
        });
    }

    if (!order) {
        console.log("Order not found for notification:", req.body.referenceId);
        return res.status(404).json({
            success: false,
            message: "Order not found"
        });
    }

    if (!order.active) {
        console.log("Order is expired", req.body.referenceId);
        return res.status(400).json({
            success: false,
            message: "Order is expired"
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

    const { success, message } = req.query;

    if (success && message) {
        return res.render("status", { order: {}, success: success === false, message });
    }

    return res.render("status", { order, success: true, message: "Payment successful" });
});

/*
=================
Online Checkout Endpoint
=================
*/
app.get("/online", async (req, res) => {
    const { cartData } = req.query;

    const data = JSON.parse(cartData);
    const totalQuantity = data.cartItems.reduce((sum, item) => sum + item.quantity, 0);

    const currentURL = req.protocol + '://' + req.get('host') + "/online";
    const returnURL = currentURL + "/return";
    const callbackURL = currentURL + "/notification";
    const cancelURL = req.protocol + '://' + req.get('host');

    let url = URLS["eShop2Online"] + "/payment/"; // ARgo URL

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
        waittime: "180",
        PaymentExpirationTime: new Date(Date.now() + 3 * 60 * 1000).toISOString(), // 3 minutes from now
        metadata: JSON.stringify({ machine_id: "3213213" })
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
        platform: "eShop2Online" // Indicate online platform
    }

    // Saving order to orders.json
    addOrderToJson(order);

    // Create signature for request body for ARgo QR
    const key = getKey(data.payment_method);
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
    // Validate signature 
    if (!validateSignature(req.query, order.platform)) {
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
        return res.redirect("/status?referenceId=" + referenceId);
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

    const { error_code, error_desc } = req.body;

    const order = getOrderFromJson(req.body.referenceId);
    console.log("Online Notification Body:", req.body);
    // Validate signature 
    if (!validateSignature(req.body, order.platform)) {
        console.log("Invalid signature for notification:", req.body.referenceId);
        return res.status(400).json({
            success: false,
            message: "Invalid signature"
        });
    }

    if (!order) {
        console.log("Order not found for notification:", req.body.referenceId);
        return res.status(404).json({
            success: false,
            message: "Order not found"
        });
    }

    if (!order.active) {
        console.log("Order is expired", req.body.referenceId);
        return res.status(400).json({
            success: false,
            message: "Order is expired"
        });
    }

    if (!order.isDelivering) {
        // Start delivery process if not already started
        deliverProducts(req.body.referenceId);
    }

    const data = req.body;

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
    const randomNumber2 = Math.floor(Math.random() * 1000);
    text += Math.round(timestamp / randomNumber2 * 1.5) + randomNumber;
    return text;
}

function getKey(payment_method) {
    if (payment_method === "arvdnqr") {
        return process.env.arvdnqrkey;
    } else if (payment_method === "eShop2QR" || payment_method === "eShop2Online") {
        return process.env.eshop2offlinekey;
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
    console.log("Hash String:", hashString);
    return crypto
        .createHmac("sha256", key)
        .update(hashString, "utf8")
        .digest("hex");
}

// Validate Signature
function validateSignature(data, payment_method) {
    const signature = data.signature;
    const expectedHash = generateHash(data, getKey(payment_method));
    console.log("Validating Signature:", { signature, expectedHash });
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
    return
    // const url = "https://api.arvending.com.my/arvdnqrapi/dstatus";

    const order = getOrderFromJson(referenceId);

    if (order.isDelivering) return; // Prevent multiple delivery processes

    updateOrderInJson(referenceId, "isDelivering", true);

    let itemLeft = order.totalQuantity;
    let successCount = 0;
    console.log(`Starting delivery for order: ${referenceId}`);
    for (const item of order.items) {

        for (let i = 0; i < item.quantity; i++) {
            // Simulate delivery process
            const success = Math.random() <= 0.7; // 70% chance of successful delivery
            if (success) {
                successCount += 1;
            }

            itemLeft -= 1; // Decrease the count of items left to deliver

            // For DStatus API
            const requestItemDetail = {
                "itemID": item.id,
                "itemName": item.name,
                "alisName": item.name,
                "alisNumber": item.id
            }

            const machine_id = order.referenceId.split("-")[0];
            const orderId = createOrderID(machine_id) + "-" + item.id;

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

            const hash = generateHash(requestBody, getKey(order.platform));
            requestBody["signature"] = hash;

            // For orders.json
            const deliveryStatus = {
                orderId: orderId,
                deliverySuccess: success,
                timestamp: Date.now()
            }


            try {

                // console.log("Dstatus Request Body:", requestBody);
                const url = URLS[order.platform] + "/dstatus/";


                const response = await axios.post(url, qs.stringify(requestBody), {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                });
                const data = response.data;

                // console.log("Signature Valid:", validateSignature(data.data));
                if (!success && data.data) {

                    // Validate signature
                    if (!validateSignature(data.data, order.platform)) {
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
                // console.log(`Item ${order.totalQuantity - itemLeft} \ndelivery response:`, data, "\n========================");

                // Update refund status in orders.json
                item.deliveryStatus.push(deliveryStatus);
                updateOrderInJson(referenceId, "items", order.items);

                // Emit delivery status via Socket.io
                io.to(`order_${referenceId}`).emit("deliveryStatus", {
                    total: order.totalQuantity,
                    itemDelivered: order.totalQuantity - itemLeft,
                    deliverySuccess: success,
                    successCount: successCount,
                    isRefunded: deliveryStatus.refunded
                });

            } catch (e) {
                console.log("ERROR on refund request", e.response ? e.response.data : e.message);
            }

            const timeoutDuration = Math.floor(Math.random() * 10) + 5; // Random delay between 5 to 15 seconds
            await new Promise(resolve => setTimeout(resolve, timeoutDuration * 1000));
        }

    }

    updateOrderInJson(referenceId, "isDelivering", false);
    updateOrderInJson(referenceId, "active", false);
}
