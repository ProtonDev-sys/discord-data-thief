document.addEventListener('DOMContentLoaded', loadFiles);

function loadFiles() {
    fetch('/files')
        .then(response => response.json())
        .then(files => {
            const fileList = document.getElementById('fileList');
            fileList.innerHTML = ''; // Clear current list
            files.forEach(file => {
                const li = document.createElement('li');
                li.textContent = file.originalName;

                // Create and append the download button
                const downloadButton = document.createElement('button');
                downloadButton.textContent = 'Download';
                downloadButton.classList.add('download-button');
                downloadButton.onclick = () => window.location.href = `/download/${file.id}`;
                li.appendChild(downloadButton);

                // Create and append the delete button
                const deleteButton = document.createElement('button');
                deleteButton.textContent = 'Delete';
                deleteButton.classList.add('delete-button');
                deleteButton.onclick = () => deleteFile(file.id);
                li.appendChild(deleteButton);

                fileList.appendChild(li);
            });
        });
}

function deleteFile(fileId) {
    fetch(`/delete/${fileId}`, { method: 'DELETE' })
        .then(() => {
            loadFiles(); // Refresh the list after deletion
        });
}

document.getElementById('file').addEventListener('change', function() {
    if (this.files && this.files.length > 0) {
        const file = this.files[0];
        const fileInfo = document.getElementById('fileInfo');
        fileInfo.textContent = `Selected File: ${file.name}, Size: ${formatBytes(file.size)}`;
    }
});

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

document.getElementById('uploadForm').addEventListener('submit', function(event) {
    event.preventDefault(); // Prevent the default form submission

    const fileInput = document.getElementById('file');
    if (fileInput.files.length === 0) {
        alert('Please select a file to upload');
        return;
    }

    // Show the progress bar
    const progressBar = document.getElementById('uploadProgress');
    progressBar.value = 0;
    progressBar.style.display = 'block';

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload', true);

    xhr.upload.onprogress = function(event) {
        if (event.lengthComputable) {
            const percentComplete = (event.loaded / event.total) * 100;
            progressBar.value = percentComplete;
            if (percentComplete == 100) {
                const processingMessage = document.createElement('div');
                processingMessage.id = 'processingMessage';
                processingMessage.textContent = 'Processing...';
                document.body.appendChild(processingMessage);
            }
        }
    };

    xhr.onload = function() {
        
        if (xhr.status === 200) {
            // Display processing message
            progressBar.style.display = 'none';
            

            // Refresh page after a short delay to allow for server processing
            setTimeout(function() {
                window.location.reload();
            }, 1000); // Adjust the delay as needed
        } else {
            alert('Error uploading file');
            progressBar.style.display = 'none';
        }
    };

    xhr.onerror = function() {
        alert('Error during file upload');
        progressBar.style.display = 'none';
    };

    xhr.send(formData);
});
