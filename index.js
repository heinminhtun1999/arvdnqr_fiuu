const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const dotenv = require("dotenv");
const qs = require("qs");
const path = require("path");
const { createServer } = require("http");
const { Server } = require("socket.io");

dotenv.config();

/*
================================
Initialization and Configuration
================================
*/

const activeOrders = [];

const PORT = process.env.PORT || 3000;

const app = express();

const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.render("index");
});

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

    const body = {
        amount: data.total.toFixed(2),
        applicationCode: process.env.appcode,
        channelId: "24",
        currencyCode: "MYR",
        description: "TEST",
        hashType: "hmac-sha256",
        referenceId: referenceId,
        storeId: "17001",
        terminalId: "17001001",
        version: "v3"
    }

    const order = {
        referenceId: referenceId,
        amount: data.total.toFixed(2),
        items: data.cartItems.map(item => ({ ...item, deliveryStatus: [] })),
        timestamp: Date.now(),
        active: true,
        paymentCompleted: false
    }
    console.log(order)
    activeOrders.push(order);

    let hashString = "";
    for (const key in body) {
        hashString += body[key];
    }

    const hash = generateHash(hashString);

    body["signature"] = hash;
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
        }

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

    const existingOrder = activeOrders.find(o => o.referenceId === order.referenceId);

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

    let hashString = "";
    for (const key in body) {
        hashString += body[key];
    }

    const hash = generateHash(hashString);

    body["signature"] = hash;

    try {

        const response = await axios.post(url, body, {
            headers: {
                'Content-Type': 'application/json'
            }
        })

        console.log("CANCEL RESPONSE", response.data);

        // if (response.data.success && response.data.response.statusCode === "00") {
        //     const existingOrderIndex = activeOrders.fin
        // }

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

    const order = activeOrders.find(o => o.referenceId === req.body.referenceId);

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

    if (data.statusCode == "99") {
        console.log(`Payment for order ${data.referenceId} failed.`);
        order.paymentCompleted = false;
        io.emit(`paymentStatus${data.referenceId}`, {
            status: false,
            message: "Payment failed",
            referenceId: data.referenceId
        });
    } else if (data.statusCode == "00") {
        console.log(`Payment for order ${data.referenceId} successful.`);
        order.paymentCompleted = true;
        io.emit(`paymentStatus${data.referenceId}`, {
            status: true,
            message: "Payment successful",
            referenceId: data.referenceId
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
    const order = activeOrders.find(o => o.referenceId === referenceId);
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
Helper Functions
================ 
*/

function createOrderID() {
    let text = "ARV001-";
    const timestamp = Date.now();
    text += timestamp;
    return text;
}

function generateHash(data) {
    // iPay88: Signature = HMAC_SHA512(key, MerchantCode + RefNo + Amount(without ".") + Currency)
    // Do NOT prepend the key into the data string; key goes only into createHmac.
    return crypto
        .createHmac("sha256", process.env.key)
        .update(data, "utf8")
        .digest("hex");
}

function checkTimeout(duration, referenceId) {
    const order = activeOrders.find(o => o.referenceId === referenceId);

    let timePassed = 0;
    const interval = setInterval(() => {

        if (timePassed >= duration) {
            if (order && !order.paymentCompleted) {
                order.active = false;
                io.emit("paymentStatus", {
                    status: false,
                    message: "Payment expired"
                });
                console.log(`Order ${referenceId} has timed out. Cancelling...`);
            }
            clearInterval(interval);
        }
        timePassed++;
    }, 1000)
}


function deliverProduct() {

}