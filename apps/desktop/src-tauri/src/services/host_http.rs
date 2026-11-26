use crate::models::host_status::HostStatus;
use crate::models::ipc_error::{IpcError, IpcErrorCode};
use crate::services::local_host::LaunchStatus;
use crate::state::host::ManagedHost;
use reqwest::{Client, Method, RequestBuilder, Response, Url, header::ORIGIN, redirect::Policy};
use serde::{Deserialize, de::DeserializeOwned};
use std::net::{Ipv4Addr, SocketAddrV4};
use std::time::Duration;

const STATUS_PATH: &str = "/api/desktop/status";
const STATUS_TIMEOUT: Duration = Duration::from_secs(2);
const STATUS_LIMIT_BYTES: usize = 256;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostProbe {
    protocol_version: u8,
    node_version: String,
}

pub(crate) struct HostClient {
    http: Client,
}

impl HostClient {
    pub(crate) fn new() -> Result<Self, reqwest::Error> {
        let http = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(STATUS_TIMEOUT)
            .build()?;
        Ok(Self { http })
    }

    pub(crate) async fn status(&self, host: &ManagedHost) -> Result<HostStatus, IpcError> {
        match host.status() {
            LaunchStatus::Starting => return Ok(HostStatus::starting()),
            LaunchStatus::Ready(_) => {}
            LaunchStatus::Failed(message) => {
                return Err(IpcError::new(IpcErrorCode::HostUnavailable, message));
            }
        }
        let response = self
            .request(host, Method::GET, STATUS_PATH)?
            .timeout(STATUS_TIMEOUT)
            .send()
            .await
            .map_err(transport_error)?;
        if !response.status().is_success() {
            return Err(invalid_response());
        }
        let probe: HostProbe = read_json(response, STATUS_LIMIT_BYTES).await?;
        if probe.protocol_version != 1 || !node_version_is_valid(&probe.node_version) {
            return Err(invalid_response());
        }
        Ok(HostStatus::ready(probe.node_version))
    }

    pub(crate) fn request(
        &self,
        host: &ManagedHost,
        method: Method,
        path: &'static str,
    ) -> Result<RequestBuilder, IpcError> {
        let address = host.endpoint().ok_or_else(|| {
            IpcError::new(
                IpcErrorCode::HostUnavailable,
                "The local Praxis host is unavailable.",
            )
        })?;
        self.request_at(address, method, path)
    }

    fn request_at(
        &self,
        address: SocketAddrV4,
        method: Method,
        path: &'static str,
    ) -> Result<RequestBuilder, IpcError> {
        if *address.ip() != Ipv4Addr::LOCALHOST || address.port() == 0 {
            return Err(invalid_response());
        }
        let origin = format!("http://{address}");
        let mut url = Url::parse(&origin).map_err(|_| invalid_response())?;
        url.set_path(path);
        Ok(self.http.request(method, url).header(ORIGIN, origin))
    }
}

pub(crate) async fn read_json<T: DeserializeOwned>(
    mut response: Response,
    limit: usize,
) -> Result<T, IpcError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err(invalid_response());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid_response())
}

pub(crate) fn transport_error(error: reqwest::Error) -> IpcError {
    if error.is_timeout() {
        IpcError::new(
            IpcErrorCode::HostTimedOut,
            "The local Praxis host did not respond in time.",
        )
    } else {
        IpcError::new(
            IpcErrorCode::HostUnavailable,
            "The local Praxis host is unavailable.",
        )
    }
}

pub(crate) fn invalid_response() -> IpcError {
    IpcError::new(
        IpcErrorCode::InvalidHostResponse,
        "The local Praxis host returned an unsupported response.",
    )
}

fn node_version_is_valid(version: &str) -> bool {
    let mut components = version.split('.');
    components.clone().count() == 3
        && components.all(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && part.parse::<u16>().is_ok()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_routes_use_only_the_supervised_loopback_origin() {
        let client = HostClient::new().unwrap();
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 54321);
        let request = client
            .request_at(address, Method::GET, STATUS_PATH)
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(
            request.url().as_str(),
            "http://127.0.0.1:54321/api/desktop/status"
        );
        assert_eq!(request.headers()[ORIGIN], "http://127.0.0.1:54321");
        assert!(
            client
                .request_at(
                    SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 54321),
                    Method::GET,
                    STATUS_PATH
                )
                .is_err()
        );
    }

    #[test]
    fn a_runtime_version_cannot_include_paths_or_unbounded_diagnostics() {
        assert!(node_version_is_valid("24.22.3"));
        for invalid in [
            "24.22",
            "24.22.70000",
            "+24.22.3",
            "private/24.22.3",
            "24.22.3.4",
        ] {
            assert!(!node_version_is_valid(invalid));
        }
    }
}
