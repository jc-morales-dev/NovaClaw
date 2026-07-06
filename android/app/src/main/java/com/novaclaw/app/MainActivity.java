package com.novaclaw.app;

import com.getcapacitor.BridgeActivity;
import com.novaclaw.app.plugins.ShellPlugin;
import com.novaclaw.app.plugins.SecureKeyPlugin;
import com.novaclaw.app.plugins.RuntimeInstallerPlugin;
import com.novaclaw.app.plugins.PtyPlugin;

public class MainActivity extends BridgeActivity {
 @Override
 public void onCreate(android.os.Bundle savedInstanceState) {
 registerPlugin(ShellPlugin.class);
 registerPlugin(SecureKeyPlugin.class);
 registerPlugin(RuntimeInstallerPlugin.class);
 registerPlugin(PtyPlugin.class);
 super.onCreate(savedInstanceState);
 }
}
