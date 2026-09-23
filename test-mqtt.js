// test-mqtt.js
import mqtt from 'mqtt';
import fs from 'fs';
import path from 'path';

// Create a test client
const client = mqtt.connect('mqtt://localhost:1883');

// Read a sample image and convert to base64
const imageBuffer = fs.readFileSync(path.join(process.cwd(), 'test-plate.jpg'));
const base64Image = imageBuffer.toString('base64');

// Create test payload
const testPayload = {
  plate_number: "ABC123",
  image: base64Image,
  timestamp: new Date().toISOString(),
  vehicle_description: "Test vehicle - Blue Toyota Camry"
};

client.on('connect', () => {
  console.log('Connected to broker');
  
  // Publish the test message
  client.publish('alpr/plate_reads', JSON.stringify(testPayload), (err) => {
    if (err) {
      console.error('Error publishing:', err);
    } else {
      console.log('Test message published successfully');
    }
    // Close the client
    client.end();
  });
});

client.on('error', (err) => {
  console.error('MQTT error:', err);
  client.end();
});