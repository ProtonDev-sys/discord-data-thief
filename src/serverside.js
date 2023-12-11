const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const stream = require('stream');
const fetch = require('node-fetch'); // Ensure you have 'node-fetch' installed

const app = express();
const upload = multer({ dest: 'uploads/' });
const PORT = 3000;
const DISCORD_TOKEN = 'ENTER BOT TOKEN HERE';
const DISCORD_CHANNEL_ID = 'ENTER CHANNEL ID';
const password = 'ANY PASSWORD HERE (KEEP THIS SECRET)';
const algorithm = 'aes-256-cbc';
const key = crypto.scryptSync(password, 'salt', 32);
const iv = crypto.randomBytes(16);

const discordClient = new Client({
    intents: Object.values(GatewayIntentBits)
});
discordClient.login(DISCORD_TOKEN);

const db = new sqlite3.Database('./filedata.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error(err.message);
    } else {
        console.log('Connected to the SQLite database.');
        createTables();
    }
});

function createTables() {
    db.serialize(() => {
        // Create files table
        db.run(`
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                originalName TEXT,
                encryptedName TEXT,
                encryptionKey TEXT,
                iv TEXT
            )
        `, (err) => {
            if (err) {
                console.error('Error creating files table:', err.message);
            } else {
                console.log('Files table created or already exists.');
            }
        });

        // Create chunks table
        db.run(`
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fileId INTEGER,
                discordMessageId TEXT,
                part INTEGER,
                FOREIGN KEY(fileId) REFERENCES files(id)
            )
        `, (err) => {
            if (err) {
                console.error('Error creating chunks table:', err.message);
            } else {
                console.log('Chunks table created or already exists.');
            }
        });
    });
}

process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error(err.message);
        } else {
            console.log('Closed the database connection.');
        }
        process.exit(0);
    });
});

app.use(express.static('public'));

async function splitFile(filePath, chunkSize = 25 * 1024 * 1024) {
    const fileSize = fs.statSync(filePath).size;
    const stream = fs.createReadStream(filePath, { highWaterMark: chunkSize });
    let part = 0;
    let chunks = [];

    for await (const chunk of stream) {
        const chunkName = path.join('chunks', `chunk_${part}_${path.basename(filePath)}`);
        fs.writeFileSync(chunkName, chunk);
        chunks.push(chunkName);
        part++;
    }

    return chunks;
}

app.post('/upload', upload.single('file'), async (req, res) => {
    let encryptedFilePath;
    let chunkPaths = []; // Declare chunkPaths here so it's accessible in the finally block
    let fileId;

    try {
        encryptedFilePath = await encryptFile(req.file.path, key, iv);

        // Insert file record into the database
        const insertFileSql = "INSERT INTO files (originalName, encryptedName, encryptionKey, iv) VALUES (?, ?, ?, ?)";
        const fileData = [req.file.originalname, encryptedFilePath, key.toString('hex'), iv.toString('hex')];

        fileId = await new Promise((resolve, reject) => {
            db.run(insertFileSql, fileData, function(err) {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(this.lastID);
            });
        });

        // Split and upload chunks
        chunkPaths = await splitFile(encryptedFilePath);

        for (const chunkPath of chunkPaths) {
            const discordMessageId = await uploadToDiscord(DISCORD_CHANNEL_ID, chunkPath);
            const part = chunkPaths.indexOf(chunkPath);

            // Insert chunk record into the database
            const insertChunkSql = "INSERT INTO chunks (fileId, discordMessageId, part) VALUES (?, ?, ?)";
            const chunkData = [fileId, discordMessageId, part];

            db.run(insertChunkSql, chunkData, function(err) {
                if (err) console.error('Database error:', err.message);
            });
        }

        res.send('File uploaded and processed.');
    } catch (error) {
        console.error(error);
        res.status(500).send('An error occurred.');
    } finally {
        fs.unlinkSync(req.file.path); // Delete the original file
        if (encryptedFilePath) {
            fs.unlinkSync(encryptedFilePath); // Delete the encrypted file
        }

        for (const chunkPath of chunkPaths) {
            if (fs.existsSync(chunkPath)) {
                fs.unlinkSync(chunkPath); // Delete chunk files
            }
        }
    }
});

function encryptFile(filePath, key, iv) {
    return new Promise((resolve, reject) => {
        const cipher = crypto.createCipheriv(algorithm, key, iv);
        const input = fs.createReadStream(filePath);
        const encryptedFilePath = `${filePath}.enc`;
        const output = fs.createWriteStream(encryptedFilePath);

        input.pipe(cipher).pipe(output);

        output.on('finish', () => resolve(encryptedFilePath));
        output.on('error', reject);
    });
}


async function uploadToDiscord(channelId, filePath) {
    try {
        const attachment = new AttachmentBuilder(fs.readFileSync(filePath), { name: path.basename(filePath) });
        const message = await discordClient.channels.cache.get(channelId).send({ files: [attachment] });
        return message.id; // Ensure this is returning the message ID
    } catch (error) {
        console.error('Error uploading to Discord:', error);
        throw error;
    }
}

// Route to send a list of files
app.get('/files', async (req, res) => {
    db.all("SELECT id, originalName FROM files", [], (err, rows) => {
        if (err) {
            res.status(500).send("Error retrieving files");
            return;
        }
        res.json(rows);
    });
});

async function reassembleFile(fileId, destinationPath) {
    const tempDir = path.dirname(destinationPath);

    // Ensure the temporary directory exists
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    const chunksQuery = "SELECT discordMessageId, part FROM chunks WHERE fileId = ? ORDER BY part ASC";

    try {
        const chunks = await new Promise((resolve, reject) => {
            db.all(chunksQuery, [fileId], (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(rows);
            });
        });

        // Ensure the destination file is cleared before appending data
        fs.writeFileSync(destinationPath, '');

        for (const chunk of chunks) {
            const message = await discordClient.channels.cache.get(DISCORD_CHANNEL_ID).messages.fetch(chunk.discordMessageId);
            const attachmentUrl = message.attachments.first().url;
            const response = await fetch(attachmentUrl);
            const buffer = await response.buffer();
            fs.appendFileSync(destinationPath, buffer);
        }
    } catch (error) {
        console.error('Error reassembling file:', error);
        throw error;
    }
}

function decryptFile(encryptedFilePath, decryptedFilePath, key, iv) {
    return new Promise((resolve, reject) => {
        const decipher = crypto.createDecipheriv(algorithm, key, iv);
        const input = fs.createReadStream(encryptedFilePath);
        const output = fs.createWriteStream(decryptedFilePath);

        input.pipe(decipher).pipe(output);

        output.on('finish', () => resolve(decryptedFilePath));
        output.on('error', reject);
    });
}

app.get('/download/:fileId', async (req, res) => {
    const fileId = req.params.fileId;

    try {
        // Fetch the file details from the database
        const fileQuery = "SELECT originalName, encryptedName, encryptionKey, iv FROM files WHERE id = ?";
        const file = await new Promise((resolve, reject) => {
            db.get(fileQuery, [fileId], (err, row) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(row);
            });
        });

        // Reassemble the file
        const tempEncryptedFilePath = path.join(os.tmpdir(), `temp_${file.encryptedName}`);
        await reassembleFile(fileId, tempEncryptedFilePath);

        // Decrypt the file
        const decryptedFilePath = path.join(os.tmpdir(), `decrypted_${file.originalName}`);
        await decryptFile(tempEncryptedFilePath, decryptedFilePath, Buffer.from(file.encryptionKey, 'hex'), Buffer.from(file.iv, 'hex'));

        // Send the decrypted file as response
        res.download(decryptedFilePath, file.originalName, (err) => {
            if (err) {
                console.error(err);
            }
            // Clean up: delete temporary files
            fs.unlinkSync(tempEncryptedFilePath);
            fs.unlinkSync(decryptedFilePath);
        });
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).send('Failed to download file');
    }
});

app.delete('/delete/:fileId', async (req, res) => {
    const fileId = req.params.fileId;
    try {
        // Delete the file record from the database
        const deleteFileSql = "DELETE FROM files WHERE id = ?";
        await new Promise((resolve, reject) => {
            db.run(deleteFileSql, [fileId], (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            });
        });

        // Optionally, also delete related chunks from the chunks table
        const deleteChunksSql = "DELETE FROM chunks WHERE fileId = ?";
        await new Promise((resolve, reject) => {
            db.run(deleteChunksSql, [fileId], (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            });
        });

        res.status(200).send('File deleted');
    } catch (error) {
        console.error('Error deleting file:', error);
        res.status(500).send('Failed to delete file');
    }
});


discordClient.on('ready', () => {
    console.log(`Logged in as ${discordClient.user.tag}!`);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
