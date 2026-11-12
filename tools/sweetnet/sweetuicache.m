/*
 * sweetuicache: register (or unregister) an app bundle with LaunchServices
 * so SpringBoard shows it, like the jailbreak-era `uicache -p`. Run as root:
 *   sweetuicache /Applications/Foo.app        register as a system app
 *   sweetuicache -u /Applications/Foo.app     unregister
 *   sweetuicache -U BUNDLE.app DATA_DIR       register as a normal (User) app: bundle in /var/containers/Bundle/Application/UUID,
 *                                             data container DATA_DIR (HOME/TMPDIR point into it)
 *   sweetuicache -V                           print the version and capabilities ("user-containers")
 * Uses the private LSApplicationWorkspace API (MobileCoreServices), resolved
 * at run time; the binary is signed with the LaunchServices entitlements.
 */
#import <Foundation/Foundation.h>
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

@interface LSApplicationWorkspace : NSObject
+ (instancetype)defaultWorkspace;
- (BOOL)registerApplicationDictionary:(NSDictionary *)dict;
- (BOOL)unregisterApplication:(NSURL *)url;
- (BOOL)registerApplication:(NSURL *)url;
@end

int
main(int argc, char **argv)
{
	@autoreleasepool {
		if (argc == 2 && strcmp(argv[1], "-V") == 0) {
			printf("sweetuicache 2 user-containers\n");
			return 0;
		}
		int unregister = argc == 3 && strcmp(argv[1], "-u") == 0;
		int user = argc == 4 && strcmp(argv[1], "-U") == 0;
		if (argc != 2 && !unregister && !user) {
			fprintf(stderr, "usage: sweetuicache [-u] /Applications/App.app | -U BUNDLE.app DATA_DIR | -V\n");
			return 2;
		}
		NSString *path = [NSString stringWithUTF8String:user ? argv[2] : argv[argc - 1]];
		dlopen("/System/Library/Frameworks/MobileCoreServices.framework/MobileCoreServices", RTLD_NOW);
		Class ws = NSClassFromString(@"LSApplicationWorkspace");
		if (ws == nil) {
			fprintf(stderr, "sweetuicache: LSApplicationWorkspace not found\n");
			return 1;
		}
		LSApplicationWorkspace *w = [ws defaultWorkspace];
		NSURL *url = [NSURL fileURLWithPath:path];
		if (unregister) {
			BOOL ok = [w unregisterApplication:url];
			printf("sweetuicache: unregister %s -> %s\n", argv[2], ok ? "ok" : "FAILED");
			return ok ? 0 : 1;
		}
		NSDictionary *info = [NSDictionary dictionaryWithContentsOfFile:[path stringByAppendingPathComponent:@"Info.plist"]];
		NSString *bid = info[@"CFBundleIdentifier"];
		if (bid == nil) {
			fprintf(stderr, "sweetuicache: %s has no CFBundleIdentifier\n", argv[1]);
			return 1;
		}
		if (user) {
			NSString *data = [NSString stringWithUTF8String:argv[3]];
			NSDictionary *udict = @{
				@"ApplicationType": @"User",
				@"CFBundleIdentifier": bid,
				@"CodeInfoIdentifier": bid,
				@"CompatibilityState": @0,
				@"IsDeletable": @YES,
				@"Path": path,
				@"Container": data,
				@"EnvironmentVariables": @{
					@"HOME": data,
					@"CFFIXED_USER_HOME": data,
					@"TMPDIR": [data stringByAppendingPathComponent:@"tmp"],
				},
				@"SignerIdentity": @"Apple iPhone OS Application Signing",
			};
			BOOL uok = [w registerApplicationDictionary:udict];
			if (!uok) {
				uok = [w registerApplication:url];
			}
			printf("sweetuicache: register %s (%s) as a user app, data %s -> %s\n", argv[2], bid.UTF8String, argv[3], uok ? "ok" : "FAILED");
			return uok ? 0 : 1;
		}
		NSDictionary *dict = @{
			@"ApplicationType": @"System",
			@"CFBundleIdentifier": bid,
			@"CodeInfoIdentifier": bid,
			@"CompatibilityState": @0,
			@"IsDeletable": @NO,
			@"Path": path,
			@"SignerOrganization": @"Apple Inc.",
			@"SignerIdentity": @"Apple iPhone OS Application Signing",
		};
		BOOL ok = [w registerApplicationDictionary:dict];
		if (!ok) {
			ok = [w registerApplication:url];
		}
		printf("sweetuicache: register %s (%s) -> %s\n", argv[1], bid.UTF8String, ok ? "ok" : "FAILED");
		return ok ? 0 : 1;
	}
}
