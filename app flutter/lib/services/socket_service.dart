import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'auth_service.dart';
import '../constants.dart';

class SocketService {
  IO.Socket? socket;

  Future<void> init({
    required Function(Map<String, dynamic>) onNewMessage,
    required Function(Map<String, dynamic>) onModifiedMessage,
  }) async {
    final token = await AuthService.getToken();
    socket = IO.io(
      Constants.socketUrl,
      IO.OptionBuilder()
          .setTransports(['websocket'])
          .setPath('/socket.io')
          .enableAutoConnect()
          .setExtraHeaders({'Authorization': 'Bearer $token'})
          .setQuery({'token': token})
          .build(),
    );

    socket!.onConnect((_) {
      // Unisciti alla chat al momento della connessione
      socket!.emit('join_chat');
    });

    socket!.on('new_message', (data) {
      onNewMessage(Map<String, dynamic>.from(data));
    });

    socket!.on('modified_message', (data) {
      onModifiedMessage(Map<String, dynamic>.from(data));
    });

    socket!.onDisconnect((_) => print("Disconnesso"));
  }

  void sendMessage(String msg) {
    socket?.emit('send_message', {'message': msg});
  }

  void dispose() {
    socket?.dispose();
  }
}
