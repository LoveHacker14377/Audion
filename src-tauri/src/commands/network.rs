// Network commands for CORS-free HTTP requests
// These commands allow the frontend/plugins to make HTTP requests through the Rust backend,
// bypassing browser CORS restrictions.

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// represents one field in a multipart/form-data body
// Text fields: set value, leave filename/content_type/data_base64 as None
// File fields: set filename, content_type, and data_base64 (base64-encoded bytes)
#[derive(Debug, Deserialize)]
pub struct FormPart {
    pub name: String,
    // for text parts
    pub value: Option<String>,
    // for file/blob parts
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub data_base64: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ProxyFetchRequest {
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
    pub form_data: Option<Vec<FormPart>>, // multipart/form-data parts
}

#[derive(Debug, Serialize)]
pub struct ProxyFetchResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

/// Proxy fetch command - makes HTTP requests from the Rust backend to bypass CORS
#[tauri::command]
pub async fn proxy_fetch(request: ProxyFetchRequest) -> Result<ProxyFetchResponse, String> {
    let client = reqwest::Client::new();

    let method = request.method.unwrap_or_else(|| "GET".to_string());
    let method = method
        .parse::<reqwest::Method>()
        .map_err(|e| format!("Invalid HTTP method: {}", e))?;

    let mut req_builder = client.request(method, &request.url);

    // Build a HeaderMap so custom headers override defaults
    // do not set Content-Type here when sending multipart as reqwest sets it
    // automatically with the correct boundary after .multipart is called
    let mut header_map = HeaderMap::new();
    header_map.insert("User-Agent",      HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"));
    header_map.insert("Accept",          HeaderValue::from_static("application/json, text/plain, */*"));
    header_map.insert("Accept-Language", HeaderValue::from_static("en-US,en;q=0.9"));
    header_map.insert("Cache-Control",   HeaderValue::from_static("no-cache"));

    // Custom headers override defaults (replaces existing keys)
    if let Some(headers) = request.headers {
        for (key, value) in headers {
            // skip Content-Type when multipart is present as reqwest owns that header
            if request.form_data.is_some() {
                let lower = key.to_lowercase();
                if lower == "content-type" {
                    continue;
                }
            }
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(key.as_bytes()),
                HeaderValue::from_str(&value),
            ) {
                header_map.insert(name, val);
            }
        }
    }

    req_builder = req_builder.headers(header_map);

    // multipart body takes priority over plain string body
    if let Some(parts) = request.form_data {
        use base64::{engine::general_purpose::STANDARD, Engine};

        let mut form = reqwest::multipart::Form::new();

        for part in parts {
            if let Some(data_b64) = part.data_base64 {
                // File/blob part
                let bytes = STANDARD
                    .decode(&data_b64)
                    .map_err(|e| format!("Invalid base64 in form part '{}': {}", part.name, e))?;

                let mut mp = reqwest::multipart::Part::bytes(bytes);

                if let Some(filename) = part.filename {
                    mp = mp.file_name(filename);
                }
                if let Some(ct) = part.content_type {
                    mp = mp.mime_str(&ct)
                        .map_err(|e| format!("Invalid MIME type in part '{}': {}", part.name, e))?;
                }

                form = form.part(part.name, mp);
            } else if let Some(value) = part.value {
                // plain text part
                form = form.text(part.name, value);
            }
            // if neither value nor data_base64 is set, skip the part
        }

        req_builder = req_builder.multipart(form);
    } else if let Some(body) = request.body {
        req_builder = req_builder.body(body);
    }

    let response = req_builder
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status().as_u16();

    // Collect response headers
    let mut headers = HashMap::new();
    for (key, value) in response.headers() {
        if let Ok(v) = value.to_str() {
            headers.insert(key.to_string(), v.to_string());
        }
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    Ok(ProxyFetchResponse {
        status,
        headers,
        body,
    })
}

#[tauri::command]
pub async fn proxy_fetch_bytes(url: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response bytes: {}", e))?;

    Ok(STANDARD.encode(bytes))
}
