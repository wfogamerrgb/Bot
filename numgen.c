#include <stdio.h>

#define START      1
#define END        9999
#define PER_FILE   450

int main(void) {
    FILE *out = NULL;
    int file_num = 0;
    int count_in_file = 0;

    for (int n = START; n <= END; n++) {
        /* Open a new file every PER_FILE numbers */
        if (count_in_file == 0) {
            char filename[32];
            file_num++;
            snprintf(filename, sizeof(filename), "numbers_%02d.txt", file_num);
            out = fopen(filename, "w");
            if (!out) {
                perror("Could not create file");
                return 1;
            }
        }

        fprintf(out, "%04d\n", n);
        count_in_file++;

        /* Close the file when it's full or we're done */
        if (count_in_file == PER_FILE || n == END) {
            fclose(out);
            out = NULL;
            count_in_file = 0;
        }
    }

    printf("Done. Created %d files.\n", file_num);
    return 0;
}
