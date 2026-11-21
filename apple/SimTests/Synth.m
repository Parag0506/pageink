#import "Synth.h"
#import <XCTest/XCTest.h>
#import <objc/runtime.h>

@interface NSObject (SynthPrivate)
- (instancetype)initForTouchAtPoint:(CGPoint)point offset:(double)offset;
- (void)moveToPoint:(CGPoint)point atOffset:(double)offset;
- (void)liftUpAtOffset:(double)offset;
- (instancetype)initWithName:(NSString *)name interfaceOrientation:(long long)orientation;
- (void)addPointerEventPath:(id)path;
- (BOOL)synthesizeWithError:(NSError **)error;
@end

static NSError *SynthError(NSString *what) {
  return [NSError errorWithDomain:@"SimTests" code:1 userInfo:@{NSLocalizedDescriptionKey : what}];
}

BOOL SynthTouches(NSArray<NSArray<NSValue *> *> *paths, NSTimeInterval duration, long long orientation,
                  NSError **error) {
  Class pathClass = NSClassFromString(@"XCPointerEventPath");
  Class recordClass = NSClassFromString(@"XCSynthesizedEventRecord");
  if (!pathClass || !recordClass || ![recordClass instancesRespondToSelector:@selector(synthesizeWithError:)]) {
    if (error) *error = SynthError(@"XCTest has no event synthesis classes in this version.");
    return NO;
  }
  id record = [[recordClass alloc] initWithName:@"touches" interfaceOrientation:orientation];
  for (NSArray<NSValue *> *points in paths) {
    if (points.count < 1) continue;
    id path = [[pathClass alloc] initForTouchAtPoint:points[0].CGPointValue offset:0];
    NSUInteger steps = points.count - 1;
    for (NSUInteger i = 1; i < points.count; i++) {
      [path moveToPoint:points[i].CGPointValue atOffset:duration * (double)i / (double)MAX(steps, 1)];
    }
    [path liftUpAtOffset:duration + 0.05];
    [record addPointerEventPath:path];
  }
  return [record synthesizeWithError:error];
}

static void AddSelectors(NSMutableString *out, NSString *name) {
  Class c = NSClassFromString(name);
  if (!c) {
    [out appendFormat:@"%@: missing\n", name];
    return;
  }
  for (Class k = c; k && k != [NSObject class]; k = class_getSuperclass(k)) {
    unsigned int n = 0;
    Method *list = class_copyMethodList(k, &n);
    for (unsigned int i = 0; i < n; i++) {
      [out appendFormat:@"%@ %@\n", NSStringFromClass(k), NSStringFromSelector(method_getName(list[i]))];
    }
    free(list);
  }
}

NSString *SynthSelectors(void) {
  NSMutableString *out = [NSMutableString string];
  for (NSString *name in @[
         @"XCPointerEventPath", @"XCSynthesizedEventRecord", @"XCPointerEvent", @"XCUIDevice", @"XCUICoordinate"
       ]) {
    AddSelectors(out, name);
  }
  return out;
}
