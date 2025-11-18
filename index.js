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

dotenv.config();

/*
================================
Initialization and Configuration
================================
*/

const PORT = process.env.PORT || 3000;

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

(async () => {
    const data = fs.readFileSync(orderJsonFilePath);
    const orders = JSON.parse(data);
    console.log("Initial data:", orders);
    // fs.unlinkSync(orderJsonFilePath);
})()



/*
=================
Checkout Endpoint
=================
*/
app.post("/checkout", async (req, res) => {
    const { cartData } = req.body;

    const data = JSON.parse(cartData);
    const totalQuantity = data.cartItems.reduce((sum, item) => sum + item.quantity, 0);

    // let url = "https://opa.merchant.razer.com/RMS/API/MOLOPA/precreate.php";
    let url = "https://api.arvending.com.my/arvdnqrapi/precreate"; // ARgo URL

    const referenceId = createOrderID();

    // Create request body for ARgo QR
    const body = {
        // applicationCode: process.env.appcode
        version: "v3",
        channelId: "24",
        storeId: "17001",
        description: "TEST",
        referenceId: referenceId,
        currencyCode: "MYR",
        amount: data.total.toFixed(2),
        hashType: "hmac-sha256",
        terminalId: "17001001"
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
        isDelivering: false
    }

    // Saving order to orders.json
    addOrderToJson(order);

    // Create signature for request body for ARgo QR
    const hash = generateHash(body);
    body["signature"] = hash;

    try {
        const response = await axios.post(url, qs.stringify(body), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });


        const data = response.data;
        if (data.success && data.response.statusCode === "00") {

            // Start timeout check (3 minutes)
            checkTimeout(180, referenceId);
            return res.render("payment", { data: data.response });
        } else {
            return res.send("Error creating order");
        }

        // Need to implement signature validation for response here

    } catch (e) {
        console.log("ERROR", e.response.data);
        return res.send("Error");
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

    const url = "https://api.arvending.com.my/arvdnqrapi/reversal";

    const body = {
        version: "v3",
        referenceId: referenceId,
        paymentReferenceId: referenceId,
        hashType: "hmac-sha256",
    }

    const hash = generateHash(body);
    body["signature"] = hash;

    try {

        const response = await axios.post(url, qs.stringify(body), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        })

        if (response.data.success && response.data.response.statusCode === "00") {
            // Update order to inactive
            updateOrderInJson(referenceId, "active", false); //need to implement retry mechanism here
            console.log("Order cancelled successfully:", referenceId);
        } else {
            console.log("Failed to cancel order:", referenceId);
        }

        // Need to implement signature validation for response here

    } catch (e) {
        console.log("ERROR", e);
    }

    return res.redirect("/");
});

/*
=====================
Notification Endpoint
=====================
*/
app.post("/notification", (req, res) => {
    console.log("Notification received:", req.body);

    // Validate signature - Disabled for testing purposes
    // const hash = generateHash(req.body);
    // if (hash !== req.body.signature) {
    //     console.log("Invalid signature for notification:", req.body.referenceId);
    //     return res.status(400).json({
    //         success: false,
    //         message: "(40103) Invalid signature"
    //     });
    // }

    const order = getOrderFromJson(req.body.referenceId);

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
    const referenceId = data.referenceId;
    if (data.statusCode == "99") {
        console.log(`Payment for order ${data.referenceId} failed.`);
        updateOrderInJson(referenceId, "paymentCompleted", false);
        io.to(`order_${referenceId}`).emit("paymentStatus", {
            status: false,
            message: "Payment failed",
            referenceId
        });
    } else if (data.statusCode == "00") {
        console.log(`Payment for order ${data.referenceId} successful.`);
        updateOrderInJson(referenceId, "paymentCompleted", true);
        io.to(`order_${referenceId}`).emit("paymentStatus", {
            status: true,
            message: "Payment successful",
            referenceId
        });
    }

    return res.send({ success: true, message: "RECEIVEDOK" });
});

/*
===============
Delivery Status
===============
*/
app.get("/status", (req, res) => {
    const referenceId = req.query.referenceId;
    const order = getOrderFromJson(referenceId);
    console.log("Order status requested:", referenceId, order);

    res.render("status", { order });
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
function createOrderID() {
    let text = "ARV001-";
    const randomNumber = Math.floor(Math.random() * 1000);
    const timestamp = Date.now();
    text += timestamp + randomNumber;
    return text;
}

// Generate HMAC SHA256 hash
function generateHash(data) {
    // iPay88: Signature = HMAC_SHA512(key, MerchantCode + RefNo + Amount(without ".") + Currency)
    // Do NOT prepend the key into the data string; key goes only into createHmac.

    let dataCopy = { ...data };
    delete dataCopy["signature"]; // Remove signature field if exists

    dataCopy = Object.keys(dataCopy).sort().reduce((obj, key) => {
        obj[key] = dataCopy[key];
        return obj;
    }, {});

    let hashString = "";
    for (const key in dataCopy) {
        hashString += dataCopy[key];
    }

    return crypto
        .createHmac("sha256", process.env.key)
        .update(hashString, "utf8")
        .digest("hex");
}

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

    const url = "https://api.arvending.com.my/arvdnqrapi/dstatus";

    const order = getOrderFromJson(referenceId);

    if (order.isDelivering) {
        // console.log("Delivery already in progress for order:", referenceId);
        return;
    }

    updateOrderInJson(referenceId, "isDelivering", true);

    let itemLeft = order.totalQuantity;
    let successCount = 0;

    for (const item of order.items) {
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

        const orderId = createOrderID() + "-" + item.id;

        const requestBody = {
            "hashType": "hmac-sha256",
            "referenceId": referenceId,
            "orderId": orderId,
            "statusCode": success ? "00" : "99",
            "itemDesc": JSON.stringify(requestItemDetail),
            "itemsToDispance": itemLeft.toString(),
            "amount": item.price.toFixed(2)
        }

        const hash = generateHash(requestBody);
        requestBody["signature"] = hash;

        // For orders.json
        const deliveryStatus = {
            orderId: orderId,
            deliverySuccess: success,
            timestamp: Date.now()
        }

        try {
            const response = await axios.post(url, qs.stringify(requestBody), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
            console.log("response", response.data);
            const data = response.data.data;

            if (data.statusCode === "00" && !success) {
                deliveryStatus.refunded = true;
            } else if (data.statusCode === "99" && !success) {
                deliveryStatus.refunded = false;
            }

            // Log response for debugging
            console.log(`Item ${order.totalQuantity - itemLeft} \ndelivery response:`, response.data, "\n========================");

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
            console.log("ERROR", e);
        }

        const timeoutDuration = Math.floor(Math.random() * 10) + 5; // Random delay between 5 to 15 seconds
        await new Promise(resolve => setTimeout(resolve, timeoutDuration * 1000));
    }
}