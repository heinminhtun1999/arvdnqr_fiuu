const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const dotenv = require("dotenv");
const qs = require("qs")

dotenv.config();

const createOrderID = () => {
    let text = "ARtest-";
    const timestamp = Date.now();
    text += timestamp;
    return text;
}

const generateHash = (data) => {
    // iPay88: Signature = HMAC_SHA512(key, MerchantCode + RefNo + Amount(without ".") + Currency)
    // Do NOT prepend the key into the data string; key goes only into createHmac.
    return crypto
        .createHmac("sha256", process.env.secretkey)
        .update(data, "utf8")
        .digest("hex");
}

const PORT = process.env.PORT || 3000;

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");

app.get("/", (req, res) => {
    console.log(req.query.qr)
    res.render("index", { qr: req.query.qr });
});

app.post("/get-qr", async (req, res) => {
    let url = "https://opa.merchant.razer.com/RMS/API/MOLOPA/precreate.php";

    const body = {
        amount: 0.10.toFixed(2),
        applicationCode: process.env.appcode,
        channelId: "24",
        currencyCode: "MYR",
        description: "TEST",
        hashType: "hmac-sha256",
        referenceId: createOrderID(),
        storeId: "17001",
        terminalId: "17001001",
        version: "v3"
    }

    let hashString = "";
    for (const key in body) {

        hashString += body[key];
    }
    console.log(hashString)

    const hash = generateHash(hashString);

    body["signature"] = hash;
    console.log(body)
    console.log(typeof body['amount'])

    try {
        const response = await axios.post(url, qs.stringify(body), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        console.log(response.data);
        res.redirect(`/?qr=${response.data.imageUrl}`)

    } catch (e) {
        console.log("ERROR", e.response.data);
        res.send("Error");
    }

});

app.get("/return", (req, res) => {
    console.log("return query", req.query);
    res.send("Return URL");
});

app.get("/notification", (req, res) => {
    console.log("query", req.query);
    res.send("Notification received");
});

app.post("/notification", (req, res) => {
    console.log("body", req.body);
    res.send("Notification received");
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

