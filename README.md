# Video Processing API (HLS Conversion)

This Node.js Express API allows users to upload video files, which are then automatically converted into HTTP Live Streaming (HLS) format (`.m3u8` playlists and `.ts` segments) with multiple resolutions (720p, 480p).

## Features

*   **Video Upload:** Accepts video file uploads via a REST endpoint.
*   **HLS Conversion:** Uses `ffmpeg` to convert uploaded videos into HLS format.
*   **Multiple Resolutions:** Generates separate HLS streams for 720p and 480p resolutions.
*   **Master Playlist:** Creates a master `m3u8` playlist referencing the different resolution streams.
*   **Static Serving:** Serves the processed HLS files statically.
*   **Basic Listing:** Provides an endpoint to list processed videos.

## Prerequisites

*   **Node.js:** Version 14.x or higher recommended.
*   **npm** or **yarn:** Package manager for Node.js.
*   **ffmpeg:** The API uses the `@ffmpeg-installer/ffmpeg` package, which downloads a compatible `ffmpeg` binary automatically during installation. No separate system-wide installation of ffmpeg is strictly required for the basic functionality.

## Installation

1.  **Clone the repository (or download the files):**
    ```bash
    git clone <repository_url>
    cd video-processing-api
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    # or
    yarn install
    ```
    This will install Express, Multer, Fluent-ffmpeg, CORS, and the ffmpeg installer.

## Configuration

The API uses the following directory structure within the project root:

*   `videos/`: Stores the original uploaded video files. This directory is created automatically if it doesn't exist.
*   `processed_videos/`: Stores the output HLS files (`.m3u8`, `.ts`). Each processed video gets its own subdirectory named after its unique ID (derived from the upload filename). This directory is also created automatically.

You can modify the following constants in `index.js` if needed:

*   `PORT`: The port the server listens on (default: 4200).
*   `VIDEOS_DIR`: Path to the original uploads directory.
*   `PROCESSED_DIR`: Path to the HLS output directory.
*   `resolutions` (inside `convertToHls` function): An array defining the target resolutions, sizes, and bitrates for HLS conversion.
*   `upload` (Multer configuration): Adjust `limits.fileSize` for maximum upload size or `fileFilter` for allowed video types.
*   `app.use(cors({ origin: '*' }))`: Modify CORS settings for production environments to restrict allowed origins.

## Running the Server

Start the API server using:

```bash
npm start
# or
yarn start
```

The console will output messages indicating the server has started and the URLs for uploading and accessing videos.

## API Endpoints

### 1. Upload Video

*   **Endpoint:** `POST /upload`
*   **Method:** `POST`
*   **Content-Type:** `multipart/form-data`
*   **Form Field:** Expects a single file field named `video`.

*   **Description:** Uploads a video file. The server accepts the file, saves it to the `videos/` directory, and immediately returns a `202 Accepted` response indicating that processing has started in the background. The HLS conversion happens asynchronously.

*   **Example using `curl`:**
    ```bash
    curl -X POST -F "video=@/path/to/your/video.mp4" http://localhost:4200/upload
    ```

*   **Success Response (202 Accepted):**
    ```json
    {
      "message": "Video uploaded successfully. Processing started.",
      "videoId": "1678886400000-your_video_mp4", // Example ID derived from filename
      "originalFilename": "your_video.mp4"
    }
    ```

*   **Error Responses:**
    *   `400 Bad Request`: If no file is uploaded, the file type is invalid, or a Multer error occurs (e.g., file size limit exceeded).
    *   `500 Internal Server Error`: If an unexpected server error occurs during upload.

### 2. List Processed Videos

*   **Endpoint:** `GET /videos`
*   **Method:** `GET`

*   **Description:** Returns a list of videos that have been processed (i.e., have a corresponding directory in `processed_videos/`).

*   **Success Response (200 OK):**
    ```json
    [
      {
        "id": "1678886400000-your_video_mp4",
        "masterPlaylistUrl": "/processed/1678886400000-your_video_mp4/master.m3u8"
      },
      {
        "id": "1678886500000-another_video_mov",
        "masterPlaylistUrl": "/processed/1678886500000-another_video_mov/master.m3u8"
      }
      // ... more videos
    ]
    ```
    If no videos have been processed, an empty array `[]` is returned.

*   **Error Response:**
    *   `500 Internal Server Error`: If there's an issue reading the `processed_videos/` directory.

### 3. Access Processed HLS Streams

*   **URL Format:** `http://localhost:4200/processed/<videoId>/master.m3u8`
*   **Method:** `GET`

*   **Description:** Access the master HLS playlist for a processed video. This URL can be used in HLS-compatible video players (like HLS.js, Video.js, native iOS/macOS players) to stream the video with adaptive bitrate switching between the generated 480p and 720p resolutions.

*   **Example:**
    `http://localhost:4200/processed/1678886400000-your_video_mp4/master.m3u8`

    The player will then request the individual resolution playlists (e.g., `/processed/<videoId>/720p/playlist.m3u8`) and video segments (`.ts` files) as needed.

## HLS Conversion Details

The `convertToHls` function in `index.js` performs the conversion using `fluent-ffmpeg`. Key aspects:

*   **Resolutions:** Currently configured for 480p (`854x480`) and 720p (`1280x720`).
*   **Codecs:** Uses H.264 for video (`libx264`) and AAC for audio.
*   **Segmentation:** Creates 10-second video segments (`.ts` files).
*   **Playlists:** Generates individual `playlist.m3u8` files for each resolution and a `master.m3u8` file for adaptive streaming.
*   **Asynchronous Processing:** Conversion happens in the background after the upload request completes, allowing the API to respond quickly. Check the server console logs for processing progress and completion status.

## Customization

*   **Add/Remove Resolutions:** Modify the `resolutions` array in `convertToHls`.
*   **FFmpeg Options:** Adjust the `.outputOptions()` array within the `ffmpeg` command in `convertToHls` to change encoding settings (quality, bitrate, codecs, segment duration, etc.). Refer to the `fluent-ffmpeg` and `ffmpeg` documentation for available options.
*   **Error Handling:** Enhance error handling, potentially adding a status tracking mechanism (e.g., using a database) to report processing failures.
*   **Original File Deletion:** Uncomment the `fs.unlink` line in the `/upload` endpoint's `convertToHls().then()` block if you want to delete the original uploaded video after successful HLS conversion.
*   **Subtitles:** The code includes a commented-out `TEXT_SUBTITLES_DIR`. You could extend the API to accept subtitle files (e.g., `.vtt`, `.srt`) during upload and integrate them into the HLS streams using appropriate ffmpeg options.
