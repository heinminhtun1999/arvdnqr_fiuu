const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const dotenv = require("dotenv");
const path = require("path");
const { createServer } = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const cors = require("cors");

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
    const data = fs.readFileSync(orderJsonFilePath);
    console.log("Initial data:", JSON.parse(data));
    fs.unlinkSync(orderJsonFilePath);
    fs.writeFileSync(orderJsonFilePath, JSON.stringify([]));
}

/*
=================
Checkout Endpoint
=================
*/

app.post("/checkout", async (req, res) => {
    const { cartData } = req.body;

    const data = JSON.parse(cartData);

    // let url = "https://opa.merchant.razer.com/RMS/API/MOLOPA/precreate.php";
    let url = "https://api.arvending.com.my/arvdnqrapi/precreate"; // ARgo URL

    const referenceId = createOrderID();

    // Create request body for ARgo QR
    const body = {
        amount: data.total.toFixed(2),
        // applicationCode: process.env.appcode
        channelId: "24",
        currencyCode: "MYR",
        description: "TEST",
        hashType: "hmac-sha256",
        referenceId: referenceId,
        storeId: "17001",
        terminalId: "17001001",
        version: "v3"
    }

    // Create order object and add to activeOrders
    const order = {
        referenceId: referenceId,
        amount: data.total.toFixed(2),
        items: data.cartItems.map(item => ({ ...item, deliveryStatus: [] })),
        timestamp: Date.now(),
        active: true,
        paymentCompleted: false
    }

    // Saving order to orders.json
    addOrderToJson(order);

    // Create signature for request body for ARgo QR
    const hash = generateHash(body);
    body["signature"] = hash;

    console.log("Checkout request received 2:", "Reference ID:", referenceId);
    try {
        const response = await axios.post(url, body, {
            headers: {
                'Content-Type': 'application/json'
            }
        });


        const data = response.data;
        if (data.success && data.response.statusCode === "00") {

            // Start timeout check (3 minutes)
            checkTimeout(180, referenceId);
            return res.render("payment", { data: data.response });
        } else {
            res.send("Error creating order");
        }

        // Need to implement signature validation for response here

    } catch (e) {
        console.log("ERROR", e.response.data);
        res.send("Error");
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

        const response = await axios.post(url, body, {
            headers: {
                'Content-Type': 'application/json'
            }
        })

        console.log("CANCEL RESPONSE", response.data);

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
=====================
Delivery Status
=====================
*/

app.get("/status", (req, res) => {
    const referenceId = req.query.referenceId;
    const order = getOrderFromJson(referenceId);
    console.log("Order status requested:", referenceId, order);
    res.render("status", { order });
});

/*================
Start the Server
================
*/

httpServer.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

/* 
================
Utility Functions
================ 
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

    let hashString = "";
    for (const key in data) {
        hashString += data[key];
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
            order.active = false;
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

// Update order in orders.json
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

function deliverProducts(referenceId) {
    const order = getOrderFromJson(referenceId);

}