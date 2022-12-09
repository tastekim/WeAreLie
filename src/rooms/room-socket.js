const lobby = require('../socket');
const RoomProvider = require('./room-provider');
const GameProvider = require('../game/game-provider');
const redis = require('../redis');
//const { findOne } = require('../schemas/user');

// 로비에 연결 되었을때
lobby.on('connection', async (socket) => {
    // 방 퇴장
    socket.on('leaveRoom', async (roomNum, nickname) => {
        try {
            await RoomProvider.leaveRoom(roomNum);
            //const leaveRoom = await RoomProvider.getRoom(roomNum);
            const currentCount = await RoomProvider.getCurrentCount(roomNum);
            socket.roomNum = null; // 여기서 socket.roomNum을 null 로 바꾼 후에 밑에 emit 하는 곳에서,
            if (currentCount > 0 && currentCount < 9) {
                await RoomProvider.decMember(roomNum, nickname);
                const currentMember = await RoomProvider.getCurrentMember(roomNum);
                const getAllRoom = await RoomProvider.getAllRoom();
                socket.emit('leaveRoom' /*, leaveRoom*/);
                lobby.sockets.emit('showRoom', getAllRoom);
                lobby.to(`/gameRoom${socket.roomNum}`).emit('userNickname', currentMember); // null 을 이용해서 emit을 하고있어서 프론트에서 계속 못받고 있었습니다.
            } else if (currentCount <= 0) {
                console.log('방이 삭제 되었습니다.');
                await RoomProvider.deleteRoom(roomNum);
                const getAllRoom = await RoomProvider.getAllRoom();
                socket.emit('leaveRoom');
                lobby.sockets.emit('showRoom', getAllRoom);
            }
        } catch (err) {
            socket.emit('error', (err.statusCode ??= 400), err.message);
        }
    });

    // 게임방생성
    socket.on('createRoom', async (gameMode, roomTitle, nickname) => {
        try {
            // 생성된 방 정보 객체
            const roomData = await RoomProvider.createRoom(gameMode, roomTitle, nickname);
            // nickname 대신에 socket.nickname?

            // 방의 currentCount 1 증가
            await RoomProvider.enterRoom(roomData._id);

            socket.roomNum = roomData._id;
            socket.isReady = 0;
            // 전체 방 리스트
            const showRoom = await RoomProvider.getAllRoom();

            // 유저 닉네임 배열 가져오기
            const currentMember = await RoomProvider.getCurrentMember(roomData._id);

            socket.emit('createRoom', roomData);
            socket.join(`/gameRoom${roomData._id}`);
            lobby.sockets.emit('userNickname', currentMember);
            lobby.sockets.emit('showRoom', showRoom);
        } catch (err) {
            socket.emit('error', (err.statusCode ??= 400), err.message);
        }
    });

    // 게임방입장
    socket.on('enterRoom', async (roomNum) => {
        try {
            const currentCount = await RoomProvider.getCurrentCount(roomNum);
            const roomStatus = await RoomProvider.getRoomStatus(roomNum);
            let readyCount = await redis.get(`ready${roomNum}`);
            console.log(readyCount);
            socket.roomNum = roomNum;
            socket.isReady = 0;
            const nickname = socket.nickname;

            // 방에 들어와있는 인원이 최대 인원 수 보다 적고 roomStatus 가 false 상태일 때 입장 가능.
            if (currentCount < 8 && roomStatus === false) {
                console.log(`${socket.nickname} 님이 ${roomNum} 번 방에 입장하셨습니다`);
                await RoomProvider.enterRoom(roomNum);
                await RoomProvider.incMember(roomNum, nickname);
                const currentMember = await RoomProvider.getCurrentMember(roomNum);
                const currentRoom = await RoomProvider.getRoom(roomNum);
                await socket.join(`/gameRoom${roomNum}`);
                socket.emit('enterRoom', currentRoom);
                lobby.to(`/gameRoom${socket.roomNum}`).emit('userNickname', currentMember);
            } else if (currentCount >= 8) {
                socket.emit('fullRoom');
                console.log('풀방입니다.');
            }
        } catch (err) {
            socket.emit('error', (err.statusCode ??= 400), err.message);
        }
    });

    // 게임 준비
    socket.on('ready', async (roomNum, isReady) => {
        try {
            const currentCount = await RoomProvider.getCurrentCount(roomNum);
            let readyCount;
            const nickname = socket.nickname;
            if (isReady) {
                // ready 버튼 활성화 시킬 때.
                socket.isReady = 1;
                await RoomProvider.ready(roomNum, nickname);
                lobby.sockets.in(`/gameRoom${roomNum}`).emit('ready', socket.nickname, true);
                readyCount = await redis.get(`ready${roomNum}`);
                console.log(readyCount, '/', currentCount);
            } else {
                // ready 버튼 비활성화 시킬 때.
                socket.isReady = 0;
                await RoomProvider.unready(roomNum, nickname);
                lobby.sockets.in(`/gameRoom${roomNum}`).emit('ready', socket.nickname, false);
                readyCount = await redis.get(`ready${roomNum}`);
                console.log(readyCount, '/', currentCount);
            }
            // 해당하는 방의 setTimeout 의 timer id 값 가져오기.
            const readyStatus = await redis.get(`readyStatus${roomNum}`);
            readyCount = await redis.get(`ready${roomNum}`);
            if (currentCount === Number(readyCount) && currentCount > 3) {
                console.log('게임시작 5초전!');

                // 특정 방의 timer identifier 를 저장, 나중에 누군가가 ready 가 취소됬을 때 해당하는 timer id 를 찾아서 멈추기 위해.
                const readyStatus = setTimeout(async () => {
                    console.log('게임 시작 ! ');
                    // 스파이 랜덤 지정 후 게임 시작 전 emit.
                    const spyUser = await GameProvider.selectSpy(roomNum);
                    lobby.sockets.in(`/gameRoom${roomNum}`).emit('spyUser', spyUser);

                    if (socket.nickname === spyUser) {
                        socket.isSpy = 1;
                    }

                    // 카테고리 및 제시어 랜덤 지정 후 게임 시작과 같이 emit.
                    const gameData = await GameProvider.giveWord(roomNum);
                    lobby.sockets.in(`/gameRoom${roomNum}`).emit('gameStart', gameData);

                    // 게임방 진행 활성화. 다른 유저 입장 제한.
                    await RoomProvider.getTrue(roomNum);
                    await redis.del(`ready${roomNum}`);
                    await redis.del(`readyStatus${roomNum}`);
                    await redis.del(`currentMember${roomNum}`);
                }, 5000);

                // 방의 timer id 저장.
                await redis.set(`readyStatus${roomNum}`, readyStatus);
            } else if (readyStatus !== '') {
                // setTimeout 이 실행된 후 누군가 ready 를 취소했을 때 그 방의 setTimeout 정지시키기.
                clearTimeout(readyStatus);
                await redis.set(`readyStatus${roomNum}`, '');
            }
        } catch (err) {
            socket.emit('error', (err.statusCode ??= 500), err.message);
        }
    });
});
