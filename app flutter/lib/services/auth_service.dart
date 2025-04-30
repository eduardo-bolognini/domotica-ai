import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import '../constants.dart';
import '../services/chat_service.dart';

class AuthService {
  static const _storage = FlutterSecureStorage();

  static Future<bool> login(String username, String password) async {
    final res = await http.post(
      Uri.parse('${Constants.apiBaseUrl}/login'),
      body: jsonEncode({'username': username, 'password': password}),
      headers: {'Content-Type': 'application/json'},
    );

    if (res.statusCode == 200) {
      final data = jsonDecode(res.body);
      await _storage.write(key: 'token', value: data['token']);
      // salviamo anche username e password
      await _storage.write(key: 'username', value: username);
      await _storage.write(key: 'password', value: password);

      final token = await AuthService.getToken();
      final res2 = await http.post(
        Uri.parse('${Constants.apiBaseUrl}/create_chat'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
      );

      return true;
    }
    return false;
  }

  static Future<String?> getToken() => _storage.read(key: 'token');

  static Future<Map<String, String>?> getSavedCredentials() async {
    final username = await _storage.read(key: 'username');
    final password = await _storage.read(key: 'password');


    if (username != null && password != null) {
      return {'username': username, 'password': password};
    }
    return null;
  }

  static Future<void> clearCredentials() async {
    await _storage.delete(key: 'username');
    await _storage.delete(key: 'password');
    await _storage.delete(key: 'token');
  }
}
