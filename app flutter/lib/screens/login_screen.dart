import 'package:flutter/cupertino.dart';
import '../services/auth_service.dart';
import 'chat_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({Key? key}) : super(key: key);

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final usernameController = TextEditingController();
  final passwordController = TextEditingController();
  bool isLoading = false;

  Future<void> handleLogin() async {
    setState(() => isLoading = true);
    final username = usernameController.text;
    final password = passwordController.text;

    final success = await AuthService.login(username, password);

    setState(() => isLoading = false);

    if (success) {
      Navigator.pushReplacement(
        context,
        CupertinoPageRoute(builder: (_) => const ChatScreen()),
      );
    } else {
      showCupertinoDialog(
        context: context,
        builder: (_) => CupertinoAlertDialog(
          title: const Text("Errore"),
          content: const Text("Username o password non validi"),
          actions: [
            CupertinoDialogAction(
              child: const Text("OK"),
              onPressed: () => Navigator.pop(context),
            ),
          ],
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return CupertinoPageScaffold(
      navigationBar: const CupertinoNavigationBar(middle: Text("Login")),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            children: [
              CupertinoTextField(
                controller: usernameController,
                placeholder: 'Username',
              ),
              const SizedBox(height: 10),
              CupertinoTextField(
                controller: passwordController,
                placeholder: 'Password',
                obscureText: true,
              ),
              const SizedBox(height: 20),
              isLoading
                  ? const CupertinoActivityIndicator()
                  : CupertinoButton.filled(
                child: const Text("Login"),
                onPressed: handleLogin,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
