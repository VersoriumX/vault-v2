const fs = require('fs');
const path = require('path');

// Function to read all files in a directory recursively
function readFiles(dir) {
    fs.readdir(dir, { withFileTypes: true }, (err, files) => {
        if (err) {
            console.error(`Error reading directory ${dir}:`, err);
            return;
        }

        files.forEach(file => {
            const filePath = path.join(dir, file.name);
            if (file.isDirectory()) {
                // If the file is a directory, call readFiles recursively
                readFiles(filePath);
            } else {
                // Perform an action on the file (e.g., log its name)
                console.log(`Found file: ${filePath}`);
                // You can add more actions here, such as reading the file, processing it, etc.
            }
        });
    });
}

// Start reading files from the current directory
const currentDir = process.cwd(); // Get the current working directory
readFiles(currentDir);
