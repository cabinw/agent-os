#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static void fail(const char *operation) {
  fprintf(stderr, "probe holder failed: %s: %s\n", operation, strerror(errno));
  exit(1);
}

static void ready(void) {
  if (write(STDOUT_FILENO, "READY\n", 6) != 6) fail("ready");
}

static void wait_forever(void) {
  for (;;) pause();
}

static void run_chroot(const char *state_root) {
  if (chroot(state_root) != 0) fail("chroot");
  if (chdir("/") != 0) fail("chdir");
  ready();
  wait_forever();
}

static void run_tmpfile(const char *state_root, const char *trigger) {
  char proc_path[96];
  struct stat trigger_stat;
  int directory_fd = open(state_root, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (directory_fd < 0) fail("open-state");
  int file_fd = openat(directory_fd, ".", O_TMPFILE | O_RDWR | O_CLOEXEC, 0600);
  if (file_fd < 0) fail("open-tmpfile");
  if (write(file_fd, "probe\n", 6) != 6) fail("write-tmpfile");
  ready();
  while (lstat(trigger, &trigger_stat) != 0) {
    if (errno != ENOENT) fail("trigger");
    usleep(1000);
  }
  if (snprintf(proc_path, sizeof(proc_path), "/proc/self/fd/%d", file_fd) < 0) {
    fail("format-fd-path");
  }
  if (linkat(AT_FDCWD, proc_path, directory_fd, "probe-published", AT_SYMLINK_FOLLOW) !=
      0) {
    fail("linkat");
  }
  if (write(STDOUT_FILENO, "LINKED\n", 7) != 7) fail("linked");
  wait_forever();
}

int main(int argc, char **argv) {
  if (geteuid() != 0) {
    fputs("probe holder requires root\n", stderr);
    return 2;
  }
  if (argc == 3 && strcmp(argv[1], "chroot") == 0) {
    run_chroot(argv[2]);
  }
  if (argc == 4 && strcmp(argv[1], "tmpfile") == 0) {
    run_tmpfile(argv[2], argv[3]);
  }
  fputs("usage: holder chroot STATE | holder tmpfile STATE TRIGGER\n", stderr);
  return 2;
}
