# 2021학년도 2학기 창의적통합설계 B조 : AI Vision Filter 적용 framework 설계 및 개발

> 삼성의 Offload.js 프레임워크를 활용하여 AI Vision Filter를 적용한 미디어스트림을 다른 Peer로 전송하여 송출하는 프로젝트

## Contributors
이상목, 이도형, 조규상, 삼성(forked from Samsung Castanets = Offload.js framework)

## Main Components:

- Offload Server: WebRTC 통신과 관련된 signaling 관련 처리를 담당하는 서버

- Offload Worker: 카메라 하드웨어를 가진 디바이스에서 돌아가는 워커로 Client에서 요청한 방식에 따라 미디어스트림을 AI 처리하여 송신

- Client Application: TV와 같이 카메라 하드웨어나 풍부하 리소스르 가지지 않는 디바이스에서 워커에 카메라 미디어스트림을 요청하는 어플리케이션

## Build offload.js

### Install node.js version 12 or higher

### Install npm dependecies

```sh
# If error, try npm install --force
npm install 
```

### Build offload.js

This creates js files named `offload.js` and `offload-worker.js` in `dist/`.
```sh
npm run build
```

## How to run Offload Worker and samples on Web Browser

#### Generate a self signed ceritificate
```
cd offload-server/src/
openssl req -newkey rsa:2048 -nodes -keyout key.pem -x509 -days 365 -out cert.pem -subj "/CN=localhost"
cd -
```

#### Run Offload Server
```
node offload-server/src/app.js
```
* OffloadServer will listen on 5443 port for HTTPS and 9559 port for HTTP by default.

#### Run Offload Worker and sample client app on web browser

The offload worker will provide camera feature to client app running on device which does not have camera H/W.

##### offload worker

* URL :https://\<OffloadServer Address\>:5443/offload-worker
* The offload worker requires camera H/W and https protocol to access.

##### Sample

* URL : http://\<OffloadServer Address\>:9559/getusermedia/
* OffloadServer requires https protocol to access camera.


